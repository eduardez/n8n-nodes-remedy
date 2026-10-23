import FormData from 'form-data';
import type {
	IDataObject,
	ICredentialTestFunction,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	ICredentialDataDecryptedObject,
	IExecuteFunctions,
	IHttpRequestOptions,
} from 'n8n-workflow';

export interface RemedyCredentials {
	baseUrl: string;
	username: string;
	password: string;
	allowUnauthorizedCerts?: boolean;
}

export interface RemedyResponse<T = unknown> {
	statusCode: number;
	body: T;
	headers: Record<string, unknown>;
}

export class RemedyHttpError extends Error {
	constructor(
		message: string,
		readonly statusCode?: number,
		readonly responseBody?: unknown,
	) {
		super(message);
		this.name = 'RemedyHttpError';
	}
}

export function normalizeBaseUrl(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error('Remedy Base URL is required.');
	}
	const input = value.trim();
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error('Remedy Base URL must be a valid absolute HTTP(S) URL.');
	}
	if (!['http:', 'https:'].includes(parsed.protocol)) {
		throw new Error('Remedy Base URL must use HTTP or HTTPS.');
	}
	if (parsed.username !== '' || parsed.password !== '') {
		throw new Error('Remedy Base URL must not contain embedded credentials.');
	}
	if (parsed.search !== '' || parsed.hash !== '') {
		throw new Error('Remedy Base URL must not contain a query string or fragment.');
	}
	return input.replace(/\/+$/, '');
}

export function makeLoginForm(username: string, password: string): URLSearchParams {
	return new URLSearchParams({ username, password });
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function responseStatus(response: unknown): number | undefined {
	if (!isUnknownRecord(response)) return undefined;
	const value = response.statusCode ?? response.status;
	return typeof value === 'number' ? value : undefined;
}

function responseBody(response: unknown): unknown {
	return isUnknownRecord(response) ? response.body : undefined;
}

function nestedResponse(response: unknown): unknown {
	return isUnknownRecord(response) ? response.response : undefined;
}

function safeBody(body: unknown, credentials?: RemedyCredentials, token?: string): string {
	let text: string;
	try {
		text = typeof body === 'string' ? body : JSON.stringify(body);
	} catch {
		return 'Unparseable Remedy error response';
	}
	if (text === undefined || text.trim() === '') return 'Empty response body';
	for (const secret of [credentials?.username, credentials?.password, token]) {
		if (secret) text = text.split(secret).join('[redacted]');
	}
	text = text.replace(/AR-JWT\s+[^\s"',}]+/g, 'AR-JWT [redacted]');
	return text.slice(0, 4000);
}

function isResponse(value: unknown): value is RemedyResponse {
	return isUnknownRecord(value) && typeof value.statusCode === 'number' && isUnknownRecord(value.headers);
}

export interface RemedyRequest {
	method: 'GET' | 'POST' | 'PUT';
	url: string;
	qs?: IDataObject;
	body?: unknown;
	headers?: Record<string, string>;
	expectedStatus: number[];
	encoding?: 'json' | 'arraybuffer' | 'text';
	json?: boolean;
}
export interface RemedyPagingOptions {
	pageSize: number;
	maxPages: number;
	offset?: number;
}


export class RemedyClient {
	readonly baseUrl: string;
	private token?: string;

	constructor(
		private readonly context: IExecuteFunctions,
		readonly credentials: RemedyCredentials,
	) {
		this.baseUrl = normalizeBaseUrl(credentials.baseUrl);
	}

	async request<T = unknown>(request: RemedyRequest): Promise<RemedyResponse<T>> {
		const token = await this.getToken();
		const options: IHttpRequestOptions = {
			method: request.method,
			url: request.url,
			headers: {
				Authorization: `AR-JWT ${token}`,
				...(request.headers ?? {}),
			},
			qs: request.qs,
			body: request.body as IHttpRequestOptions['body'],
			json: request.json ?? (request.encoding !== 'arraybuffer' && request.encoding !== 'text'),
			encoding: request.encoding === 'arraybuffer' ? 'arraybuffer' : request.encoding === 'text' ? 'text' : 'json',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			skipSslCertificateValidation: Boolean(this.credentials.allowUnauthorizedCerts),
			disableFollowRedirect: true,
			timeout: 30000,
		};
		if (request.qs === undefined) delete options.qs;
		if (request.body === undefined) delete options.body;
		try {
			const raw = await this.context.helpers.httpRequest(options);
			if (!isResponse(raw)) {
				throw new RemedyHttpError('Remedy returned an invalid HTTP response without a status code.');
			}
			const response = raw as RemedyResponse<T>;
			if (!request.expectedStatus.includes(response.statusCode)) {
				throw new RemedyHttpError(
					`Remedy request failed with HTTP ${response.statusCode}: ${safeBody(response.body, this.credentials, this.token)}`,
					response.statusCode,
					response.body,
				);
			}
			return response;
		} catch (error) {
			if (error instanceof RemedyHttpError) throw error;
			const nested = nestedResponse(error);
			const status = responseStatus(error) ?? responseStatus(nested);
			const body = responseBody(error) ?? responseBody(nested);
			throw new RemedyHttpError(
				status === undefined
					? 'Remedy HTTP request failed.'
					: `Remedy request failed with HTTP ${status}: ${safeBody(body, this.credentials, this.token)}`,
				status,
				body,
			);
		}
	}

	async getMany(form: string, qs?: IDataObject): Promise<Array<Record<string, unknown>>> {
		const query = qs !== undefined && Object.keys(qs).length > 0 ? qs : undefined;
		const response = await this.request({
			method: 'GET',
			url: this.entryUrl(form),
			qs: query,
			expectedStatus: [200],
		});
		const body = this.parseJsonBody(response.body, 'list');
		if (!isPlainObject(body) || !Array.isArray(body.entries)) {
			throw new RemedyHttpError(`Remedy returned an invalid list response for ${form}.`, response.statusCode, body);
		}
		for (const entry of body.entries) {
			if (!isPlainObject(entry) || !isPlainObject(entry.values)) {
				throw new RemedyHttpError(`Remedy returned a malformed entry in the ${form} list.`, response.statusCode, body);
			}
		}
		return body.entries as Array<Record<string, unknown>>;
	}
	async *getPages(
		form: string,
		qs: IDataObject,
		options: RemedyPagingOptions,
	): AsyncGenerator<Array<Record<string, unknown>>> {
		const { pageSize, maxPages } = options;
		if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
			throw new Error('Page Size must be a positive safe integer.');
		}
		if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
			throw new Error('Max Pages must be a positive safe integer.');
		}
		let offset = options.offset === undefined ? 0 : options.offset;
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw new Error('Offset must be a non-negative safe integer.');
		}
		for (let page = 0; page < maxPages; page++) {
			const entries = await this.getMany(form, { ...qs, limit: pageSize, offset });
			if (entries.length === 0) return;
			const nextOffset = offset + entries.length;
			if (!Number.isSafeInteger(nextOffset)) {
				throw new Error('Remedy pagination offset exceeded the safe integer range.');
			}
			yield entries;
			offset = nextOffset;
			if (page === maxPages - 1) {
				throw new Error('Remedy pagination reached Max Pages before an empty page; results are incomplete.');
			}
		}
	}


	async getDirect(form: string, entryId: string): Promise<Record<string, unknown>> {
		const response = await this.request({
			method: 'GET',
			url: `${this.entryUrl(form)}/${encodeURIComponent(entryId)}`,
			expectedStatus: [200],
		});
		const body = this.parseJsonBody(response.body, 'entry');
		if (!isPlainObject(body) || !isPlainObject(body.values)) {
			throw new RemedyHttpError(`Remedy returned an invalid entry response for ${form}.`, response.statusCode, body);
		}
		return body;
	}

	entryUrl(form: string): string {
		return `${this.baseUrl}/arsys/v1/entry/${encodeURIComponent(form)}`;
	}
	extractEntryIdentity(value: string): { entryId: string; form: string; url: string } {
		const target = this.resolveApiUrl(value, 'Entry URL');
		if (target.search !== '' || target.hash !== '' || /[?#]/.test(value)) {
			throw new Error('Entry URL must not contain a query string or fragment.');
		}
		const rootPath = new URL(this.baseUrl).pathname.replace(/\/+$/, '');
		const prefix = `${rootPath}/arsys/v1/entry/`;
		if (!target.pathname.startsWith(prefix)) {
			throw new Error('Entry URL must point to a Remedy entry endpoint under the configured API root.');
		}
		const segments = target.pathname.slice(prefix.length).split('/');
		if (segments.length !== 2 || segments.some(segment => segment === '')) {
			throw new Error('Entry URL must identify exactly one form and one entry ID.');
		}
		try {
			return {
				form: decodeURIComponent(segments[0]),
				entryId: decodeURIComponent(segments[1]),
				url: target.toString(),
			};
		} catch {
			throw new Error('Entry URL contains a malformed percent-encoding.');
		}
	}


	async create(form: string, fields: Record<string, unknown>, returnedField?: string): Promise<RemedyResponse> {
		const qs: IDataObject = {};
		if (returnedField) qs.fields = `values(${returnedField})`;
		return await this.request({
			method: 'POST',
			url: this.entryUrl(form),
			qs: Object.keys(qs).length > 0 ? qs : undefined,
			headers: { 'Content-Type': 'application/json' },
			body: { values: fields },
			expectedStatus: [201],
		});
	}

	async update(form: string, entryId: string, fields: Record<string, unknown>): Promise<RemedyResponse> {
		return await this.request({
			method: 'PUT',
			url: `${this.entryUrl(form)}/${encodeURIComponent(entryId)}`,
			headers: { 'Content-Type': 'application/json' },
			body: { values: fields },
			expectedStatus: [204],
		});
	}

	async upload(form: string, entryId: string | undefined, fields: Record<string, unknown>, partName: string, fileName: string, bytes: Buffer, mimeType: string, expectedStatus: number[]): Promise<RemedyResponse> {
		const formData = new FormData();
		formData.append('entry', Buffer.from(JSON.stringify({ values: fields }), 'utf8'), {
			contentType: 'application/json; charset=UTF-8',
		});
		formData.append(partName, bytes, { filename: fileName, contentType: mimeType });
		const headers = formData.getHeaders() as Record<string, string>;
		return await this.request({
			method: entryId === undefined ? 'POST' : 'PUT',
			url: `${this.entryUrl(form)}${entryId === undefined ? '/' : `/${encodeURIComponent(entryId)}`}`,
			headers,
			body: formData,
			json: false,
			expectedStatus,
		});
	}

	async download(url: string): Promise<RemedyResponse<Buffer>> {
		const target = this.resolveDownloadUrl(url);
		const response = await this.request<Buffer>({
			method: 'GET',
			url: target,
			encoding: 'arraybuffer',
			expectedStatus: [200],
		});
		return response;
	}

	private async getToken(): Promise<string> {
		if (this.token) return this.token;
		const username = this.credentials.username;
		const password = this.credentials.password;
		if (typeof username !== 'string' || username === '' || typeof password !== 'string' || password === '') {
			throw new Error('Remedy username and password are required.');
		}
		const options: IHttpRequestOptions = {
			method: 'POST',
			url: `${this.baseUrl}/jwt/login`,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: makeLoginForm(username, password),
			encoding: 'text',
			json: false,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			skipSslCertificateValidation: Boolean(this.credentials.allowUnauthorizedCerts),
			disableFollowRedirect: true,
		};
		let response: unknown;
		try {
			response = await this.context.helpers.httpRequest(options);
		} catch (error) {
			const status = responseStatus(error) ?? responseStatus(nestedResponse(error));
			throw new RemedyHttpError(status === undefined ? 'Remedy login request failed.' : `Remedy login failed with HTTP ${status}.`, status);
		}
		const status = responseStatus(response);
		const body = responseBody(response);
		if (status === undefined || status < 200 || status >= 300) {
			throw new RemedyHttpError(status === undefined ? 'Remedy login returned an invalid response.' : `Remedy login failed with HTTP ${status}.`, status);
		}
		const token = typeof body === 'string' ? body.trim() : '';
		if (token === '') throw new RemedyHttpError('Remedy login returned an empty token.', status);
		this.token = token;
		return token;
	}

	private parseJsonBody(body: unknown, label: string): unknown {
		if (typeof body !== 'string') return body;
		try {
			return JSON.parse(body) as unknown;
		} catch {
			throw new RemedyHttpError(`Remedy returned malformed JSON for ${label}.`);
		}
	}

	private resolveApiUrl(value: string, label: string): URL {
		let target: URL;
		let base: URL;
		try {
			base = new URL(this.baseUrl);
			target = new URL(value, `${this.baseUrl}/`);
		} catch {
			throw new Error(`${label} must be a valid relative or absolute URL.`);
		}
		if (target.username !== '' || target.password !== '') throw new Error(`${label} must not contain embedded credentials.`);
		if (target.origin !== base.origin) throw new Error(`${label} must use the configured Remedy origin.`);
		const rootPath = base.pathname.replace(/\/+$/, '');
		if (rootPath !== '' && target.pathname !== rootPath && !target.pathname.startsWith(`${rootPath}/`)) {
			throw new Error(`${label} must stay under the configured Remedy API root.`);
		}
		return target;
	}

	private resolveDownloadUrl(value: string): string {
		return this.resolveApiUrl(value, 'Attachment URL').toString();
	}
}

export const remedyApiTest: ICredentialTestFunction = async function (
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
) {
	const credentialData = credential.data;
	if (credentialData === undefined) return { status: 'Error', message: 'Remedy credentials are missing.' };
	const data = credentialData as unknown as RemedyCredentials;
	try {
		const baseUrl = normalizeBaseUrl(data.baseUrl);
		if (typeof data.username !== 'string' || data.username === '' || typeof data.password !== 'string' || data.password === '') {
			throw new Error('Remedy username and password are required.');
		}
		const response = await this.helpers.request(`${baseUrl}/jwt/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			form: makeLoginForm(data.username, data.password).toString(),
			encoding: 'utf8',
			json: false,
			resolveWithFullResponse: true,
			simple: false,
			followRedirect: false,
			rejectUnauthorized: !data.allowUnauthorizedCerts,
			timeout: 30000,
		});
		const status = responseStatus(response);
		const token = responseBody(response);
		if (status !== undefined && status >= 200 && status < 300 && typeof token === 'string' && token.trim() !== '') {
			return { status: 'OK', message: 'Connection successful' };
		}
		return { status: 'Error', message: `Remedy login failed${status === undefined ? '' : ` with HTTP ${status}`}.` };
	} catch (error) {
		const status = responseStatus(error) ?? responseStatus(nestedResponse(error));
		const detail = error instanceof Error && error.message.includes('Base URL') ? error.message : 'Remedy login request failed.';
		return { status: 'Error', message: status === undefined ? detail : `${detail} (HTTP ${status})` };
	}
};

export function parseFieldsJson(value: unknown, label: string, allowEmpty = false): Record<string, unknown> {
	let parsed = value;
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed) as unknown;
		} catch {
			throw new Error(`${label} must contain valid JSON.`);
		}
	}
	if (!isPlainObject(parsed)) throw new Error(`${label} must be a plain JSON object.`);
	if (Object.prototype.hasOwnProperty.call(parsed, 'values') && isPlainObject(parsed.values)) {
		throw new Error(`${label} must contain Remedy fields directly, not a values envelope.`);
	}
	if (!allowEmpty && Object.keys(parsed).length === 0) throw new Error(`${label} must contain at least one field.`);
	return parsed;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

export function getResponseLocation(headers: Record<string, unknown>): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === 'location' && typeof value === 'string') return value;
	}
	return undefined;
}

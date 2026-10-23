import type { IDataObject, IExecuteFunctions, IBinaryKeyData, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { RESOURCES, INCIDENT_STATUS_PROJECTION, WORKLOG_COMMENT_DEFAULTS } from '../nodes/Remedy/resources';
import { qualificationFilter } from './qualification';
import { readPagingOptions } from './pagination';
import { executeRemedyHelper } from '../helpers/remedyHelpers';
import { isPlainObject, parseFieldsJson, RemedyClient, RemedyHttpError, getResponseLocation } from '../transport/RemedyClient';
import type { RemedyPagingOptions } from '../transport/RemedyClient';

const QUALIFICATION_OPERATORS: Record<string, true> = { '==': true, '!=': true, '>': true, '>=': true, '<': true, '<=': true, LIKE: true };

export interface OperationOutput {
	json: IDataObject;
	binary?: IBinaryKeyData;
}

function parameter(context: IExecuteFunctions, itemIndex: number, name: string, fallback?: unknown): unknown {
	return context.getNodeParameter(name, itemIndex, fallback);
}

function requiredString(context: IExecuteFunctions, itemIndex: number, name: string, label: string): string {
	const value = parameter(context, itemIndex, name);
	if (typeof value !== 'string' || value.trim() === '') {
		throw new NodeOperationError(context.getNode(), `${label} is required.`, { itemIndex });
	}
	return value;
}

function stringParameter(context: IExecuteFunctions, itemIndex: number, name: string, fallback = ''): string {
	const value = parameter(context, itemIndex, name, fallback);
	return typeof value === 'string' ? value : fallback;
}


function structuredFilters(value: unknown): Array<{ field: string; operator: string; value: string }> {
	if (!isPlainObject(value)) return [];
	const raw = value.filter;
	if (raw === undefined) return [];
	const rows = Array.isArray(raw) ? raw : [raw];
	return rows.map((row, index) => {
		if (!isPlainObject(row) || typeof row.field !== 'string' || row.field.trim() === '' ||
			typeof row.operator !== 'string' || typeof row.value !== 'string') {
			throw new Error(`Filter ${index + 1} requires a field, supported operator, and string value.`);
		}
		if (QUALIFICATION_OPERATORS[row.operator] !== true) throw new Error(`Filter ${index + 1} has an unsupported operator.`);
		return { field: row.field, operator: row.operator, value: row.value };
	});
}

function readLimitOffsetParameters(context: IExecuteFunctions, itemIndex: number, includeLimit: boolean): IDataObject {
	const window: IDataObject = {};
	if (includeLimit) {
		const rawLimit = parameter(context, itemIndex, 'limit', 0);
		if (rawLimit !== 0 && rawLimit !== '' && rawLimit !== undefined) {
			const limit = Number(rawLimit);
			if (!Number.isSafeInteger(limit) || limit <= 0) {
				throw new NodeOperationError(context.getNode(), 'Limit must be a positive safe integer.', { itemIndex });
			}
			window.limit = limit;
		}
	}
	const rawOffset = parameter(context, itemIndex, 'offset', 0);
	if (rawOffset !== 0 && rawOffset !== '' && rawOffset !== undefined) {
		const offset = Number(rawOffset);
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw new NodeOperationError(context.getNode(), 'Offset must be a non-negative safe integer.', { itemIndex });
		}
		window.offset = offset;
	}
	return window;
}

function buildQueryParametersInternal(
	context: IExecuteFunctions,
	itemIndex: number,
	fixedFilters: Array<{ field: string; operator: string; value: string }>,
	fixedFields: string | undefined,
	includeLimit: boolean,
): IDataObject {
	const userQualification = fixedFilters.length > 0 ? '' : stringParameter(context, itemIndex, 'qualification').trim();
	let filters: Array<{ field: string; operator: string; value: string }>;
	try {
		filters = structuredFilters(parameter(context, itemIndex, 'filters', {}));
	} catch (error) {
		throw new NodeOperationError(context.getNode(), (error as Error).message, { itemIndex });
	}
	if (userQualification !== '' && filters.length > 0) {
		throw new NodeOperationError(context.getNode(), 'Qualification cannot be combined with structured filters.', { itemIndex });
	}
	const terms = fixedFilters.map(filter => qualificationFilter(filter.field, filter.operator, filter.value));
	terms.push(...filters.map(filter => qualificationFilter(filter.field, filter.operator, filter.value)));
	const query: IDataObject = {};
	if (userQualification !== '') query.q = userQualification;
	else if (terms.length > 0) query.q = terms.join(' AND ');
	const fields = fixedFields ?? stringParameter(context, itemIndex, 'fields').trim();
	if (fields !== '') query.fields = `values(${fields})`;
	Object.assign(query, readLimitOffsetParameters(context, itemIndex, includeLimit));
	return query;
}

export function buildQueryParameters(
	context: IExecuteFunctions,
	itemIndex: number,
	fixedFilters: Array<{ field: string; operator: string; value: string }> = [],
	fixedFields?: string,
): IDataObject {
	return buildQueryParametersInternal(context, itemIndex, fixedFilters, fixedFields, true);
}

function parseResponseBody(response: { body: unknown; statusCode: number }): unknown {
	const body = response.body;
	if (body === undefined || body === null || body === '') return undefined;
	if (typeof body !== 'string') return body;
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new RemedyHttpError('Remedy returned malformed JSON after a successful write.', response.statusCode);
	}
}

function apiEntryValues(entry: Record<string, unknown>): Record<string, unknown> {
	const values = entry.values;
	if (!isPlainObject(values)) throw new RemedyHttpError('Remedy returned a malformed entry values object.');
	return values;
}

function outputRows(rows: unknown[]): OperationOutput[] {
	return rows.map(row => ({ json: (isPlainObject(row) ? row : { value: row }) as IDataObject }));
}

function successOutput(resource: string, operation: string, entryId?: string, location?: string): OperationOutput {
	const json: IDataObject = { success: true, resource, operation };
	if (entryId !== undefined) json.entryId = entryId;
	if (location !== undefined) json.location = location;
	return { json };
}


function singularInput(resource: string, operation: string, context: IExecuteFunctions, itemIndex: number): { field?: string; value: string; direct: boolean } {
	const definition = RESOURCES[resource];
	if (definition.directGet) return { value: requiredString(context, itemIndex, 'entryId', 'Entry / Request ID'), direct: true };
	let parameterName = 'workLogId';
	let field = definition.idField;
	if (resource === 'incident') parameterName = 'incidentNumber';
	else if (resource === 'company') parameterName = operation === 'getByName' ? 'companyName' : 'companyEntryId';
	else if (resource === 'workOrder' || resource === 'workInfo') parameterName = 'workOrderId';
	else if (resource === 'task') parameterName = 'taskId';
	else if (resource === 'changeRequest') parameterName = 'infrastructureChangeId';
	if (resource === 'company' && operation === 'getByName') field = 'Company';
	if (resource === 'workInfo') field = 'Work Order ID';
	return { field, value: requiredString(context, itemIndex, parameterName, parameterName), direct: false };
}

async function getMany(
	client: RemedyClient,
	context: IExecuteFunctions,
	itemIndex: number,
	form: string,
	fixedFilters: Array<{ field: string; operator: string; value: string }> = [],
	fixedFields?: string,
): Promise<Array<Record<string, unknown>>> {
	const pagingOptions = readPagingOptions(context, itemIndex);
	const query = buildQueryParametersInternal(context, itemIndex, fixedFilters, fixedFields, pagingOptions === undefined);
	if (pagingOptions === undefined) return await client.getMany(form, query);
	return await collectPages(client, form, query, {
		...pagingOptions,
		offset: Number(query.offset ?? 0),
	});
}
async function collectPages(
	client: RemedyClient,
	form: string,
	query: IDataObject,
	options: RemedyPagingOptions,
): Promise<Array<Record<string, unknown>>> {
	const entries: Array<Record<string, unknown>> = [];
	for await (const page of client.getPages(form, query, options)) {
		for (const entry of page) entries.push(entry);
	}
	return entries;
}


function requiredBinaryMetadata(context: IExecuteFunctions, itemIndex: number, item: INodeExecutionData, property: string, override: string): { fileName: string; mimeType: string } {
	const binary = item.binary?.[property];
	if (!binary) throw new NodeOperationError(context.getNode(), `Binary property "${property}" is missing.`, { itemIndex });
	const fileName = override.trim() || binary.fileName;
	if (typeof fileName !== 'string' || fileName.trim() === '') {
		throw new NodeOperationError(context.getNode(), 'Attachment filename is required or must exist in binary metadata.', { itemIndex });
	}
	return { fileName, mimeType: typeof binary.mimeType === 'string' && binary.mimeType !== '' ? binary.mimeType : 'application/octet-stream' };
}

async function uploadAttachment(
	client: RemedyClient,
	context: IExecuteFunctions,
	itemIndex: number,
	item: INodeExecutionData,
	resource: 'incident' | 'workOrder',
): Promise<OperationOutput[]> {
	const property = stringParameter(context, itemIndex, 'binaryPropertyName', 'data') || 'data';
	const targetId = resource === 'incident'
		? requiredString(context, itemIndex, 'entryId', 'Entry / Request ID')
		: requiredString(context, itemIndex, 'workOrderId', 'Work Order ID');
	const comment = requiredString(context, itemIndex, 'comment', 'Comment');
	const override = stringParameter(context, itemIndex, 'fileName');
	const metadata = requiredBinaryMetadata(context, itemIndex, item, property, override);
	let bytes: Buffer;
	try {
		bytes = await context.helpers.getBinaryDataBuffer(itemIndex, property);
	} catch {
		throw new NodeOperationError(context.getNode(), `Could not read binary property "${property}".`, { itemIndex });
	}
	if (resource === 'incident') {
		await client.upload('HPD:IncidentInterface', targetId, {
			'z1D_Details': comment,
			'z1D_WorklogDetails': comment,
			'z1D Action': 'MODIFY',
			'z1D_View_Access': 'Internal',
			'z1D_Secure_Log': 'Yes',
			'z1D_Activity_Type': 'Incident Task/Action',
			'z2AF_Act_Attachment_1': metadata.fileName,
		}, 'attach-z2AF_Act_Attachment_1', metadata.fileName, bytes, metadata.mimeType, [200, 201, 204]);
		return [successOutput(resource, 'uploadAttachment', targetId)];
	}
	await client.upload('WOI:WorkInfo', undefined, {
		'Work Log Type': 'General Information',
		'View Access': 'Public',
		'Secure Work Log': 'No',
		Description: comment,
		'Detailed Description': comment,
		'Work Order ID': targetId,
		'z2AF Work Log01': metadata.fileName,
	}, 'attach-z2AF Work Log01', metadata.fileName, bytes, metadata.mimeType, [201]);
	return [successOutput(resource, 'uploadAttachment')];
}

function attachmentRows(entries: Array<Record<string, unknown>>, type: 'worklog' | 'incident'): OperationOutput[] {
	const output: OperationOutput[] = [];
	for (const entry of entries) {
		const values = apiEntryValues(entry);
		const workLogId = values['Work Log ID'];
		const attachmentId = values['CFG Attachment ID'];
		for (let index = 1; index <= 3; index++) {
			const metadata = values[`z2AF Work Log0${index}`];
			if (metadata === undefined || metadata === null) continue;
			if (!isPlainObject(metadata) || typeof metadata.name !== 'string' || typeof metadata.href !== 'string') {
				throw new RemedyHttpError(`Malformed attachment metadata in ${type} source slot ${index}.`);
			}
			const json: IDataObject = {
				name: metadata.name,
				url: metadata.href,
				sizeBytes: typeof metadata.sizeBytes === 'number' ? metadata.sizeBytes : 0,
				type,
			};
			if (typeof workLogId === 'string') json.workLogId = workLogId;
			if (typeof attachmentId === 'string') json.attachmentId = attachmentId;
			output.push({ json });
		}
	}
	return output;
}

async function listAttachments(client: RemedyClient, context: IExecuteFunctions, itemIndex: number): Promise<OperationOutput[]> {
	const incidentNumber = requiredString(context, itemIndex, 'incidentNumber', 'Incident Number');
	const worklogQuery = {
		q: qualificationFilter('Incident Number', '==', incidentNumber),
		fields: 'values(z2AF Work Log01,z2AF Work Log02,z2AF Work Log03,Work Log ID)',
	};
	const cfgQuery = { q: qualificationFilter('Request ID01', '==', incidentNumber) };
	const pagingOptions = readPagingOptions(context, itemIndex);
	if (pagingOptions === undefined) {
		const worklogs = await client.getMany('HPD:WorkLog', worklogQuery);
		const cfg = await client.getMany('CFG:Attachments', cfgQuery);
		return [...attachmentRows(worklogs, 'worklog'), ...attachmentRows(cfg, 'incident')];
	}
	const outputs: OperationOutput[] = [];
	for await (const page of client.getPages('HPD:WorkLog', worklogQuery, { ...pagingOptions, offset: 0 })) {
		for (const item of attachmentRows(page, 'worklog')) outputs.push(item);
	}
	for await (const page of client.getPages('CFG:Attachments', cfgQuery, { ...pagingOptions, offset: 0 })) {
		for (const item of attachmentRows(page, 'incident')) outputs.push(item);
	}
	return outputs;
}

async function downloadAttachment(client: RemedyClient, context: IExecuteFunctions, itemIndex: number): Promise<OperationOutput[]> {
	const url = requiredString(context, itemIndex, 'url', 'Attachment URL');
	const property = stringParameter(context, itemIndex, 'binaryPropertyName', 'data') || 'data';
	const response = await client.download(url);
	const downloaded: unknown = response.body;
	let bytes: Buffer;
	if (Buffer.isBuffer(downloaded)) bytes = downloaded;
	else if (downloaded instanceof Uint8Array) bytes = Buffer.from(downloaded);
	else if (downloaded instanceof ArrayBuffer) bytes = Buffer.from(downloaded);
	else throw new RemedyHttpError('Remedy attachment download returned a non-binary response.');
	const rawFileName = stringParameter(context, itemIndex, 'fileName').trim();
	let fileName = rawFileName;
	if (fileName === '') {
		const path = new URL(url, `${client.baseUrl}/`).pathname;
		const segment = path.split('/').filter(part => part !== '').at(-1) ?? 'attachment';
		try {
			fileName = decodeURIComponent(segment);
		} catch {
			throw new NodeOperationError(context.getNode(), 'Could not derive a valid attachment filename from the URL.', { itemIndex });
		}
	}
	const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
	const mimeType = typeof contentType === 'string' && contentType !== '' ? contentType : 'application/octet-stream';
	const binary = await context.helpers.prepareBinaryData(bytes, fileName, mimeType);
	return [{ json: { fileName, url } as IDataObject, binary: { [property]: binary } }];
}

export async function executeOperation(
	context: IExecuteFunctions,
	client: RemedyClient,
	itemIndex: number,
	item: INodeExecutionData,
	resource: string,
	operation: string,
): Promise<OperationOutput[]> {
	if (resource === 'helper') return await executeRemedyHelper(context, client, itemIndex, operation);
	if (resource === 'attachment') {
		if (operation === 'getMany') return await listAttachments(client, context, itemIndex);
		if (operation === 'download') return await downloadAttachment(client, context, itemIndex);
	}
	const definition = RESOURCES[resource];
	if (!definition || !definition.operations.includes(operation)) {
		throw new NodeOperationError(context.getNode(), `Unknown Remedy operation "${resource}.${operation}".`, { itemIndex });
	}
	if (operation === 'getMany') {
		return outputRows(await getMany(client, context, itemIndex, definition.form));
	}
	if (operation === 'get' || operation === 'getByName') {
		const input = singularInput(resource, operation, context, itemIndex);
		if (input.direct) {
			const entry = await client.getDirect(definition.form, input.value);
			return outputRows([entry]);
		}
		const entries = await client.getMany(definition.form, {
			q: qualificationFilter(input.field ?? '', '==', input.value),
			limit: 1,
		});
		return outputRows(entries.slice(0, 1));
	}
	if (operation === 'getAssigned' || operation === 'getInProgress') {
		const assignedGroup = requiredString(context, itemIndex, 'assignedGroup', 'Assigned Group');
		const status = operation === 'getAssigned' ? 'Assigned' : 'In Progress';
		const entries = await getMany(client, context, itemIndex, definition.form, [
			{ field: 'Assigned Group', operator: '==', value: assignedGroup },
			{ field: 'Status', operator: '==', value: status },
		], INCIDENT_STATUS_PROJECTION);
		return outputRows(entries);
	}
	if (operation === 'create') {
		const extraFields = parseFieldsJson(parameter(context, itemIndex, 'fieldsJson', '{}'), 'Fields JSON', resource === 'workInfo');
		if (resource === 'workInfo') {
			const explicitFields: Record<string, unknown> = {
				'Detailed Description': requiredString(context, itemIndex, 'detailedDescription', 'Detailed Description'),
				'Work Order ID': requiredString(context, itemIndex, 'workOrderId', 'Work Order ID'),
				'Work Log Type': stringParameter(context, itemIndex, 'workLogType', WORKLOG_COMMENT_DEFAULTS.workLogType),
				'View Access': stringParameter(context, itemIndex, 'viewAccess', WORKLOG_COMMENT_DEFAULTS.viewAccess),
				'Secure Work Log': stringParameter(context, itemIndex, 'secureWorkLog', WORKLOG_COMMENT_DEFAULTS.secureWorkLog),
			};
			for (const key of Object.keys(explicitFields)) {
				if (Object.prototype.hasOwnProperty.call(extraFields, key)) {
					throw new NodeOperationError(context.getNode(), `Fields JSON cannot override explicit WorkInfo field "${key}".`, { itemIndex });
				}
			}
			Object.assign(explicitFields, extraFields);
			const response = await client.create(definition.createForm ?? definition.form, explicitFields);
			const body = parseResponseBody(response);
			return body === undefined ? [successOutput(resource, operation, undefined, getResponseLocation(response.headers))] : outputRows([body]);
		}
		const response = await client.create(definition.createForm ?? definition.form, extraFields, definition.createIdField);
		const body = parseResponseBody(response);
		return body === undefined
			? [successOutput(resource, operation, undefined, getResponseLocation(response.headers))]
			: outputRows([body]);
	}
	if (operation === 'update' || operation === 'setStatus') {
		const entryId = requiredString(context, itemIndex, 'entryId', 'Entry / Request ID');
		const fields = operation === 'update'
			? parseFieldsJson(parameter(context, itemIndex, 'fieldsJson', '{}'), 'Fields JSON')
			: { [definition.statusField ?? 'Status']: requiredString(context, itemIndex, 'status', 'Status') };
		await client.update(definition.form, entryId, fields);
		return [successOutput(resource, operation, entryId)];
	}
	if (operation === 'assign') {
		const entryId = requiredString(context, itemIndex, 'entryId', 'Entry / Request ID');
		await client.update(definition.form, entryId, {
			Assignee: requiredString(context, itemIndex, 'assignee', 'Assignee'),
			'Assignee Login ID': requiredString(context, itemIndex, 'assigneeLoginId', 'Assignee Login ID'),
		});
		return [successOutput(resource, operation, entryId)];
	}
	if (operation === 'resolve') {
		const entryId = requiredString(context, itemIndex, 'entryId', 'Entry / Request ID');
		await client.update(definition.form, entryId, {
			Status: 'Resolved',
			Status_Reason: 'Automated Resolution Reported',
			Resolution: requiredString(context, itemIndex, 'resolution', 'Resolution'),
			'Resolution Category': requiredString(context, itemIndex, 'resolutionCategory', 'Resolution Category'),
			'Resolution Category Tier 2': requiredString(context, itemIndex, 'resolutionCategoryTier2', 'Resolution Category Tier 2'),
			'Resolution Category Tier 3': requiredString(context, itemIndex, 'resolutionCategoryTier3', 'Resolution Category Tier 3'),
		});
		return [successOutput(resource, operation, entryId)];
	}
	if (operation === 'addComment') {
		const isIncident = resource === 'incident';
		const relatedId = requiredString(context, itemIndex, isIncident ? 'incidentNumber' : 'workOrderId', isIncident ? 'Incident Number' : 'Work Order ID');
		const fields: Record<string, unknown> = {
			'Detailed Description': requiredString(context, itemIndex, 'detailedDescription', 'Detailed Description'),
			[isIncident ? 'Incident Number' : 'Work Order ID']: relatedId,
			'Work Log Type': stringParameter(context, itemIndex, 'workLogType', WORKLOG_COMMENT_DEFAULTS.workLogType),
			'View Access': stringParameter(context, itemIndex, 'viewAccess', WORKLOG_COMMENT_DEFAULTS.viewAccess),
			'Secure Work Log': stringParameter(context, itemIndex, 'secureWorkLog', WORKLOG_COMMENT_DEFAULTS.secureWorkLog),
		};
		await client.create(isIncident ? 'HPD:WorkLog' : 'WOI:WorkInfo', fields);
		return [successOutput(resource, operation)];
	}
	if (operation === 'getComments') {
		const workOrderId = requiredString(context, itemIndex, 'workOrderId', 'Work Order ID');
		const pagingOptions = readPagingOptions(context, itemIndex);
		const query: IDataObject = {
			q: qualificationFilter('Work Order ID', '==', workOrderId),
			...readLimitOffsetParameters(context, itemIndex, pagingOptions === undefined),
		};
		if (pagingOptions === undefined) return outputRows(await client.getMany('WOI:WorkInfo', query));
		return outputRows(await collectPages(client, 'WOI:WorkInfo', query, {
			...pagingOptions,
			offset: Number(query.offset ?? 0),
		}));
	}
	if (operation === 'uploadAttachment') {
		return await uploadAttachment(client, context, itemIndex, item, resource as 'incident' | 'workOrder');
	}
	throw new NodeOperationError(context.getNode(), `Unknown Remedy operation "${resource}.${operation}".`, { itemIndex });
}

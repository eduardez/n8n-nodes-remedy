import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { OPEN_INCIDENT_STATUSES, RESOURCES } from '../nodes/Remedy/resources';
import type { OperationOutput } from '../execute/executeOperation';
import { readPagingOptions } from '../execute/pagination';
import { qualificationFilter } from '../execute/qualification';
import { getResponseLocation, isPlainObject, parseFieldsJson, RemedyClient, RemedyHttpError } from '../transport/RemedyClient';

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

function normalizedValue(values: Record<string, unknown>, key: string): unknown {
	const expected = key.replace(/ /g, '_').toLowerCase();
	for (const [actual, value] of Object.entries(values)) {
		if (actual.replace(/ /g, '_').toLowerCase() === expected) return value;
	}
	return undefined;
}

function firstEntry(
	context: IExecuteFunctions,
	itemIndex: number,
	entries: Array<Record<string, unknown>>,
	stage: string,
	identifier: string,
): Record<string, unknown> {
	const entry = entries[0];
	if (entry === undefined) {
		throw new NodeOperationError(context.getNode(), `${stage} lookup returned no record for ${identifier}.`, { itemIndex });
	}
	return entry;
}

function valuesOf(entry: Record<string, unknown>): Record<string, unknown> {
	const values = entry.values;
	if (!isPlainObject(values)) throw new RemedyHttpError('Remedy returned an invalid entry values object.');
	return values;
}

function output(entry: Record<string, unknown>): OperationOutput {
	return { json: entry as IDataObject };
}

function outputFromResponse(response: { body: unknown; headers: Record<string, unknown> }, resource: string, operation: string): OperationOutput[] {
	if (response.body !== undefined && response.body !== null && response.body !== '') {
		let body: unknown = response.body;
		if (typeof body === 'string') {
			try {
				body = JSON.parse(body) as unknown;
			} catch {
				throw new RemedyHttpError('Remedy returned malformed JSON after creating a record.');
			}
		}
		if (!isPlainObject(body)) throw new RemedyHttpError('Remedy returned an invalid create response body.');
		return [{ json: body as IDataObject }];
	}
	const result: IDataObject = { success: true, resource, operation };
	const location = getResponseLocation(response.headers);
	if (location !== undefined) result.location = location;
	return [{ json: result }];
}

function cutoffDate(sinceDays: number, context: IExecuteFunctions, itemIndex: number): string {
	const timestamp = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
	const cutoff = new Date(timestamp);
	if (!Number.isFinite(timestamp) || !Number.isFinite(cutoff.getTime())) {
		throw new NodeOperationError(context.getNode(), 'Since Days produces an out-of-range date.', { itemIndex });
	}
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}T${pad(cutoff.getHours())}:${pad(cutoff.getMinutes())}:${pad(cutoff.getSeconds())}`;
}

function sinceDaysValue(context: IExecuteFunctions, itemIndex: number, defaultValue: number): number {
	const value = parameter(context, itemIndex, 'sinceDays', defaultValue);
	const days = Number(value);
	if (!Number.isSafeInteger(days) || days < 0) {
		throw new NodeOperationError(context.getNode(), 'Since Days must be a non-negative safe integer.', { itemIndex });
	}
	return days;
}

function isOpen(entry: Record<string, unknown>): boolean {
	const status = valuesOf(entry).Status;
	return typeof status === 'string' && OPEN_INCIDENT_STATUSES.includes(status);
}

function stringField(entry: Record<string, unknown>, field: string): string | undefined {
	const value = valuesOf(entry)[field];
	return typeof value === 'string' ? value : undefined;
}

async function getPeopleFromSite(
	context: IExecuteFunctions,
	client: RemedyClient,
	itemIndex: number,
	locationId: string,
): Promise<Record<string, unknown>> {
	const sites = await client.getMany(RESOURCES.site.form, {
		q: [
			qualificationFilter('Location ID', '==', locationId),
			qualificationFilter('Status', '==', 'Enabled'),
		].join(' AND '),
	});
	const site = sites.find(entry => {
		const orgId = normalizedValue(valuesOf(entry), 'EVO_cs_orgid');
		return typeof orgId === 'string' && orgId !== '';
	});
	if (!site) {
		throw new NodeOperationError(context.getNode(), `Site lookup for Location ID ${locationId} returned no enabled site with EVO_cs_orgid.`, { itemIndex });
	}
	const siteId = normalizedValue(valuesOf(site), 'Site ID');
	if (typeof siteId !== 'string' || siteId === '') {
		throw new NodeOperationError(context.getNode(), `Site lookup for Location ID ${locationId} did not return Site ID.`, { itemIndex });
	}
	const orgId = normalizedValue(valuesOf(site), 'EVO_cs_orgid');
	if (typeof orgId !== 'string' || orgId === '') {
		throw new NodeOperationError(context.getNode(), `Site lookup for Location ID ${locationId} did not return EVO_cs_orgid.`, { itemIndex });
	}
	firstEntry(context, itemIndex, await client.getMany(RESOURCES.siteCompanyAssociation.form, {
		q: qualificationFilter('Site ID', '==', siteId),
	}), 'SiteCompanyAssociation', `Site ID ${siteId}`);
	const people = await client.getMany(RESOURCES.people.form, {
		q: qualificationFilter('Remedy Login ID', 'LIKE', `${orgId}/%`),
	});
	return firstEntry(context, itemIndex, people, 'People', `EVO_cs_orgid ${orgId}`);
}

interface EnrichmentRecords {
	site: Record<string, unknown>;
	association: Record<string, unknown>;
	company: Record<string, unknown>;
	people: Record<string, unknown>;
}

async function getEnrichmentRecords(
	context: IExecuteFunctions,
	client: RemedyClient,
	itemIndex: number,
	locationId: string,
): Promise<EnrichmentRecords> {
	const site = firstEntry(context, itemIndex, await client.getMany(RESOURCES.site.form, {
		q: [
			qualificationFilter('Location ID', '==', locationId),
			qualificationFilter('Status', '==', 'Enabled'),
		].join(' AND '),
	}), 'Site', `Location ID ${locationId}`);
	const siteId = normalizedValue(valuesOf(site), 'Site ID');
	if (typeof siteId !== 'string' || siteId === '') {
		throw new NodeOperationError(context.getNode(), `Site lookup for Location ID ${locationId} did not return Site ID.`, { itemIndex });
	}
	const association = firstEntry(context, itemIndex, await client.getMany(RESOURCES.siteCompanyAssociation.form, {
		q: qualificationFilter('Site ID', '==', siteId),
	}), 'SiteCompanyAssociation', `Site ID ${siteId}`);
	const companyName = normalizedValue(valuesOf(association), 'Company');
	if (typeof companyName !== 'string' || companyName === '') {
		throw new NodeOperationError(context.getNode(), `SiteCompanyAssociation for Site ID ${siteId} did not return Company.`, { itemIndex });
	}
	const company = firstEntry(context, itemIndex, await client.getMany(RESOURCES.company.form, {
		q: qualificationFilter('Company', '==', companyName),
		limit: 1,
	}), 'Company', `Company ${companyName}`);
	const companyId = normalizedValue(valuesOf(company), 'Company ID');
	if (typeof companyId !== 'string' || companyId === '') {
		throw new NodeOperationError(context.getNode(), `Company lookup for ${companyName} did not return Company ID.`, { itemIndex });
	}
	const people = firstEntry(context, itemIndex, await client.getMany(RESOURCES.people.form, {
		q: qualificationFilter('Remedy Login ID', 'LIKE', `${companyId}/%`),
	}), 'People', `Company ID ${companyId}`);
	return { site, association, company, people };
}

function truncateCodePoints(value: string): string {
	const points = Array.from(value);
	return points.length > 90 ? points.slice(0, 85).join('') : value;
}

function incidentOptions(context: IExecuteFunctions, itemIndex: number): Record<string, unknown> {
	const defaults: Record<string, unknown> = {
		assignedSupportOrganization: 'GESTION PERSONALIZADA',
		assignedSupportCompany: 'BT España',
		assignedGroup: 'L1.7x24',
		evoOwnerGestion: 'L1.MCSMONITORIZACION',
		productTier1: 'IT SYSTEMS',
		productTier2: 'PORTAL CLIENTE',
		productTier3: 'PORTAL CLIENTE',
		urgency: '2-High',
		impact: '4-Minor/Localized',
		reportedSource: 'Alarma',
		categorizationTier1: 'MONITORIZACION',
		categorizationTier2: 'AUTOMATICA',
		serviceType: 'Infrastructure Event',
	};
	const raw = parameter(context, itemIndex, 'incidentOptions', {});
	if (!isPlainObject(raw)) return defaults;
	const supplied = isPlainObject(raw.values) ? raw.values : raw;
	return { ...defaults, ...supplied };
}

async function createEnrichedIncident(context: IExecuteFunctions, client: RemedyClient, itemIndex: number): Promise<OperationOutput[]> {
	const description = truncateCodePoints(requiredString(context, itemIndex, 'description', 'Description'));
	const detailedDescription = stringParam(context, itemIndex, 'detailedDescription');
	const locationId = stringParam(context, itemIndex, 'locationId', 'S000001');
	const records = await getEnrichmentRecords(context, client, itemIndex, locationId);
	const site = valuesOf(records.site);
	const association = valuesOf(records.association);
	const people = valuesOf(records.people);
	const options = incidentOptions(context, itemIndex);
	const fields: Record<string, unknown> = {
		First_Name: normalizedValue(people, 'First Name'),
		Last_Name: normalizedValue(people, 'Last Name'),
		'Default Country': normalizedValue(people, 'Default Country'),
		'Default City': normalizedValue(people, 'Default City'),
		'State Province': normalizedValue(site, 'State Province'),
		'Site ID': normalizedValue(site, 'Site ID'),
		Site: normalizedValue(site, 'Site'),
		Company: normalizedValue(association, 'Company'),
		Description: description,
		Detailed_Decription: detailedDescription,
		Status: 'New',
		'Assigned Support Organization': options.assignedSupportOrganization,
		'Assigned Support Company': options.assignedSupportCompany,
		'Assigned Group': options.assignedGroup,
		EVO_Owner_Gestion: options.evoOwnerGestion,
		'Product Categorization Tier 1': options.productTier1,
		'Product Categorization Tier 2': options.productTier2,
		'Product Categorization Tier 3': options.productTier3,
		Urgency: options.urgency,
		Impact: options.impact,
		'Reported Source': options.reportedSource,
		'Categorization Tier 1': options.categorizationTier1,
		'Categorization Tier 2': options.categorizationTier2,
		Service_Type: options.serviceType,
	};
	if (typeof options.serviceCI === 'string' && options.serviceCI !== '') fields.ServiceCI = options.serviceCI;
	const response = await client.create('HPD:IncidentInterface_Create', fields, 'Incident Number');
	const body = response.body;
	let created: unknown = body;
	if (typeof body === 'string') {
		try {
			created = JSON.parse(body) as unknown;
		} catch {
			throw new RemedyHttpError('createEnrichedIncident: Remedy returned malformed JSON after create.');
		}
	}
	if (!isPlainObject(created) || !isPlainObject(created.values) || typeof created.values['Incident Number'] !== 'string' || created.values['Incident Number'] === '') {
		throw new RemedyHttpError('createEnrichedIncident: POST succeeded but the response did not contain Incident Number.');
	}
	const incidentNumber = created.values['Incident Number'];
	await new Promise<void>(resolve => setTimeout(resolve, 2000));
	let entries: Array<Record<string, unknown>>;
	try {
		entries = await client.getMany(RESOURCES.incident.form, {
			q: qualificationFilter('Incident Number', '==', incidentNumber),
			limit: 1,
		});
	} catch (error) {
		if (error instanceof RemedyHttpError) {
			throw new RemedyHttpError(`createEnrichedIncident: created ${incidentNumber}, but follow-up lookup failed: ${error.message}`, error.statusCode, error.responseBody);
		}
		throw error;
	}
	const entry = entries[0];
	if (entry === undefined) {
		throw new NodeOperationError(context.getNode(), `createEnrichedIncident: created ${incidentNumber}, but follow-up lookup returned no entry.`, { itemIndex });
	}
	return [output(entry)];
}

function stringParam(context: IExecuteFunctions, itemIndex: number, name: string, fallback = ''): string {
	const value = parameter(context, itemIndex, name, fallback);
	return typeof value === 'string' ? value : fallback;
}

async function createEnrichedWorkOrder(context: IExecuteFunctions, client: RemedyClient, itemIndex: number): Promise<OperationOutput[]> {
	const summary = truncateCodePoints(requiredString(context, itemIndex, 'summary', 'Summary'));
	const detailedDescription = stringParam(context, itemIndex, 'detailedDescription');
	const locationId = requiredString(context, itemIndex, 'locationId', 'Location ID');
	const records = await getEnrichmentRecords(context, client, itemIndex, locationId);
	const site = valuesOf(records.site);
	const company = valuesOf(records.company);
	const people = valuesOf(records.people);
	const companyName = normalizedValue(company, 'Company');
	const generated: Record<string, unknown> = {
		Company: companyName,
		'Customer Company': companyName,
		'Customer First Name': normalizedValue(people, 'First Name'),
		'Customer Last Name': normalizedValue(people, 'Last Name'),
		'Detailed Description': detailedDescription,
		'Location Company': companyName,
		Site: normalizedValue(site, 'Site'),
		Summary: summary,
	};
	const additional = parseFieldsJson(parameter(context, itemIndex, 'fieldsJson', '{}'), 'Fields JSON', true);
	for (const key of Object.keys(generated)) {
		if (Object.prototype.hasOwnProperty.call(additional, key)) {
			throw new NodeOperationError(context.getNode(), `Fields JSON cannot override generated WorkOrder field "${key}".`, { itemIndex });
		}
	}
	const response = await client.create('WOI:WorkOrderInterface_Create', { ...generated, ...additional }, 'WorkOrder_ID');
	return outputFromResponse(response, 'helper', 'createEnrichedWorkOrder');
}

async function closeAlertIncident(context: IExecuteFunctions, client: RemedyClient, itemIndex: number): Promise<OperationOutput[]> {
	const entryId = requiredString(context, itemIndex, 'entryId', 'Entry / Request ID');
	const completed: string[] = [];
	const steps: Array<{ name: string; fields: Record<string, unknown> }> = [
		{
			name: 'assign',
			fields: {
				Assignee: stringParam(context, itemIndex, 'assignee', 'autobot autobot'),
				'Assignee Login ID': stringParam(context, itemIndex, 'assigneeLoginId', 'autobot'),
			},
		},
		{
			name: 'resolve',
			fields: {
				Status: 'Resolved',
				Status_Reason: 'Automated Resolution Reported',
				Resolution: stringParam(context, itemIndex, 'resolution', 'Alerta remite'),
				'Resolution Category': stringParam(context, itemIndex, 'resolutionCategory', 'CUSTOMER'),
				'Resolution Category Tier 2': stringParam(context, itemIndex, 'resolutionCategoryTier2', 'ACORDE A ESPECIFICACIONES'),
				'Resolution Category Tier 3': stringParam(context, itemIndex, 'resolutionCategoryTier3', 'ACORDE AL SERVICIO CONTRATADO'),
			},
		},
		{ name: 'close', fields: { Status: 'Closed' } },
	];
	for (const step of steps) {
		try {
			await client.update(RESOURCES.incident.form, entryId, step.fields);
			completed.push(step.name);
		} catch (error) {
			const prefix = `closeAlertIncident failed at ${step.name}; completed stages: ${completed.length ? completed.join(', ') : 'none'}.`;
			const retryWarning = 'Completed stages are acknowledged successes; the failed stage may have taken effect. Verify the record before retrying.';
			if (error instanceof RemedyHttpError) {
				throw new RemedyHttpError(`${prefix} ${retryWarning} ${error.message}`, error.statusCode, error.responseBody);
			}
			throw new NodeOperationError(context.getNode(), `${prefix} ${retryWarning} ${(error as Error).message}`, { itemIndex });
		}
	}
	return [{ json: { success: true, entryId, status: 'Closed' } }];
}

function getQueueForTime(context: IExecuteFunctions, itemIndex: number): OperationOutput[] {
	const raw = stringParam(context, itemIndex, 'dateTime');
	const timeZone = stringParam(context, itemIndex, 'timeZone');
	let formatter: Intl.DateTimeFormat | undefined;
	if (timeZone !== '') {
		try {
			formatter = new Intl.DateTimeFormat('en-GB', {
				timeZone,
				hour: '2-digit',
				hourCycle: 'h23',
			});
		} catch {
			throw new NodeOperationError(context.getNode(), 'Time Zone must be a valid IANA time zone.', { itemIndex });
		}
		if (raw !== '' && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
			throw new NodeOperationError(context.getNode(), 'Date Time must include Z or a numeric offset when Time Zone is set.', { itemIndex });
		}
	}
	const date = raw === '' ? new Date() : new Date(raw);
	if (Number.isNaN(date.getTime())) {
		throw new NodeOperationError(context.getNode(), 'Date Time must be a valid date/time value.', { itemIndex });
	}
	const hour = formatter === undefined
		? date.getHours()
		: Number(formatter.formatToParts(date).find(part => part.type === 'hour')?.value);
	const dayShift = hour >= 8 && hour <= 18;
	return [{
		json: {
			assignedGroup: dayShift ? 'L1.AVERIAS_GP' : 'L1.7x24',
			assignedSupportOrganization: 'GESTION PERSONALIZADA',
		},
	}];
}

export async function executeRemedyHelper(
	context: IExecuteFunctions,
	client: RemedyClient,
	itemIndex: number,
	operation: string,
): Promise<OperationOutput[]> {
	if (operation === 'extractEntryId') {
		const entryUrl = requiredString(context, itemIndex, 'entryUrl', 'Entry URL');
		return [{ json: client.extractEntryIdentity(entryUrl) }];
	}
	if (operation === 'findOpenIncidentsByFragments') {
		const raw = parameter(context, itemIndex, 'descriptionFragments');
		let fragments: unknown = raw;
		if (typeof raw === 'string') {
			try {
				fragments = JSON.parse(raw) as unknown;
			} catch {
				throw new NodeOperationError(context.getNode(), 'Description Fragments JSON must be a valid JSON array.', { itemIndex });
			}
		}
		if (!Array.isArray(fragments) || fragments.length === 0 ||
			fragments.some(fragment => typeof fragment !== 'string' || fragment.trim() === '')) {
			throw new NodeOperationError(context.getNode(), 'Description Fragments must be a non-empty array of non-blank strings.', { itemIndex });
		}
		const fragmentList = fragments as string[];
		const days = sinceDaysValue(context, itemIndex, 1);
		const assignedGroup = requiredString(context, itemIndex, 'assignedGroup', 'Assigned Group');
		const assignedOrganization = requiredString(context, itemIndex, 'assignedSupportOrganization', 'Assigned Support Organization');
		const query = {
			q: [
				qualificationFilter('Assigned Group', '==', assignedGroup),
				qualificationFilter('Assigned Support Organization', '==', assignedOrganization),
				qualificationFilter('Last Modified Date', '>', cutoffDate(days, context, itemIndex)),
			].join(' AND '),
		};
		const pagingOptions = readPagingOptions(context, itemIndex);
		const matches = (entry: Record<string, unknown>) => {
			const description = stringField(entry, 'Description');
			return description !== undefined && fragmentList.some(fragment => description.includes(fragment)) && isOpen(entry);
		};
		if (pagingOptions === undefined) {
			const entries = await client.getMany(RESOURCES.incident.form, query);
			return entries.filter(matches).map(output);
		}
		const matchesFound: OperationOutput[] = [];
		for await (const page of client.getPages(RESOURCES.incident.form, query, pagingOptions)) {
			for (const entry of page) {
				if (matches(entry)) matchesFound.push(output(entry));
			}
		}
		return matchesFound;
	}
	if (operation === 'findOpenIncidentByDescription') {
		const description = requiredString(context, itemIndex, 'description', 'Description');
		const days = sinceDaysValue(context, itemIndex, 4);
		const query = {
			q: [
				qualificationFilter('Description', '==', description),
				qualificationFilter('Last Modified Date', '>', cutoffDate(days, context, itemIndex)),
			].join(' AND '),
		};
		const pagingOptions = readPagingOptions(context, itemIndex);
		const matches = (entry: Record<string, unknown>) => stringField(entry, 'Description') === description && isOpen(entry);
		if (pagingOptions === undefined) {
			const entries = await client.getMany(RESOURCES.incident.form, query);
			const found = entries.find(matches);
			return found === undefined ? [] : [output(found)];
		}
		for await (const page of client.getPages(RESOURCES.incident.form, query, pagingOptions)) {
			const found = page.find(matches);
			if (found !== undefined) return [output(found)];
		}
		return [];
	}
	if (operation === 'getPeopleFromSite') {
		const locationId = requiredString(context, itemIndex, 'locationId', 'Location ID');
		const entry = await getPeopleFromSite(context, client, itemIndex, locationId);
		return [output(entry)];
	}
	if (operation === 'createEnrichedIncident') return await createEnrichedIncident(context, client, itemIndex);
	if (operation === 'createEnrichedWorkOrder') return await createEnrichedWorkOrder(context, client, itemIndex);
	if (operation === 'closeAlertIncident') return await closeAlertIncident(context, client, itemIndex);
	if (operation === 'getQueueForTime') return getQueueForTime(context, itemIndex);
	throw new NodeOperationError(context.getNode(), `Unknown Remedy helper operation "${operation}".`, { itemIndex });
}

import type { INodeProperties } from 'n8n-workflow';

import { RESOURCES } from '../resources';

const OPERATION_LABELS: Record<string, string> = {
	get: 'Get One',
	getMany: 'Get Many',
	getAssigned: 'Get Assigned Incidents',
	getInProgress: 'Get In-Progress Incidents',
	getByName: 'Get by Company Name',
	create: 'Create',
	update: 'Update',
	setStatus: 'Set Status',
	assign: 'Assign',
	resolve: 'Resolve',
	addComment: 'Add Comment',
	getComments: 'Get Comments',
	uploadAttachment: 'Upload Attachment',
	download: 'Download',
	extractEntryId: 'Extract Entry ID',
	findOpenIncidentsByFragments: 'Find Open Incidents by Fragments',
	findOpenIncidentByDescription: 'Find Open Incident by Exact Description',
	getPeopleFromSite: 'Get People from Site',
	createEnrichedIncident: 'Create Enriched Incident',
	createEnrichedWorkOrder: 'Create Enriched Work Order',
	closeAlertIncident: 'Close Alert Incident',
	getQueueForTime: 'Get Queue for Time',
};

function when(resource: string, operations: string[]): INodeProperties['displayOptions'] {
	return { show: { resource: [resource], operation: operations } };
}

function field(
	displayName: string,
	name: string,
	type: INodeProperties['type'],
	operations: string[],
	resource: string,
	options: Partial<INodeProperties> = {},
): INodeProperties {
	return { displayName, name, type, default: '', displayOptions: when(resource, operations), ...options };
}

const ordinaryListResources = Object.keys(RESOURCES).filter(resource =>
	RESOURCES[resource].operations.includes('getMany') && resource !== 'attachment');
const pagedResources = [...ordinaryListResources, 'attachment', 'helper'];
const pagedOperations = [
	'getMany', 'getAssigned', 'getInProgress', 'getComments',
	'findOpenIncidentsByFragments', 'findOpenIncidentByDescription',
];
const queryFields: INodeProperties[] = [
	{
		displayName: 'Qualification',
		name: 'qualification',
		type: 'string',
		default: '',
		description: 'Remedy qualification expression. Do not combine with structured filters.',
		displayOptions: { show: { resource: ordinaryListResources, operation: ['getMany'] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'fixedCollection',
		default: {},
		placeholder: 'Add Filter',
		typeOptions: { multipleValues: true },
		options: [{
			name: 'filter',
			displayName: 'Filter',
			values: [
				{ displayName: 'Field', name: 'field', type: 'string', default: '' },
				{
					displayName: 'Operator',
					name: 'operator',
					type: 'options',
					options: ['==', '!=', '>', '>=', '<', '<=', 'LIKE'].map(value => ({ name: value, value })),
					default: '==',
				},
				{ displayName: 'Value', name: 'value', type: 'string', default: '' },
			],
		}],
		displayOptions: {
			show: { resource: ordinaryListResources, operation: ['getMany', 'getAssigned', 'getInProgress'] },
		},
	},
	{
		displayName: 'Fields',
		name: 'fields',
		type: 'string',
		default: '',
		description: 'Comma-separated Remedy fields to return. Omit to use the form default.',
		displayOptions: { show: { resource: ordinaryListResources, operation: ['getMany'] } },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 0,
		// Keep Remedy's documented zero sentinel; the generic limit rule disallows zero.
		// eslint-disable-next-line n8n-nodes-base/node-param-min-value-wrong-for-limit
		typeOptions: { minValue: 0 },
		// eslint-disable-next-line n8n-nodes-base/node-param-description-excess-final-period, n8n-nodes-base/node-param-description-wrong-for-limit
		description: '0 uses the server default; otherwise a positive integer.',
		displayOptions: {
			show: {
				resource: ordinaryListResources,
				operation: ['getMany', 'getAssigned', 'getInProgress', 'getComments'],
				returnAll: [false],
			},
		},
	},
	{
		displayName: 'Offset',
		name: 'offset',
		type: 'number',
		default: 0,
		typeOptions: { minValue: 0 },
		description: 'Optional non-negative result offset',
		displayOptions: {
			show: { resource: ordinaryListResources, operation: ['getMany', 'getAssigned', 'getInProgress', 'getComments'] },
		},
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: { resource: pagedResources, operation: pagedOperations } },
	},
	{
		displayName: 'Page Size',
		name: 'pageSize',
		type: 'number',
		default: 100,
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: pagedResources, operation: pagedOperations, returnAll: [true] } },
	},
	{
		displayName: 'Max Pages',
		name: 'maxPages',
		type: 'number',
		default: 100,
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: pagedResources, operation: pagedOperations, returnAll: [true] } },
	},
];

export function buildProperties(): INodeProperties[] {
	const properties: INodeProperties[] = [
		{
			displayName: 'Resource',
			name: 'resource',
			type: 'options',
			noDataExpression: true,
			options: Object.entries(RESOURCES).map(([value]) => ({
				name: value.replace(/[A-Z]/g, letter => ` ${letter}`).replace(/^./, letter => letter.toUpperCase()),
				value,
			})),
			default: 'incident',
		},
	];
	for (const [resource, definition] of Object.entries(RESOURCES)) {
		properties.push({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			options: definition.operations.map(operation => ({
				name: OPERATION_LABELS[operation] ?? operation,
				value: operation,
			})),
			default: definition.operations[0],
			displayOptions: { show: { resource: [resource] } },
		});
	}
	properties.push(...queryFields);
	for (const [resource, definition] of Object.entries(RESOURCES)) {
		const singularOps = definition.operations.includes('get') ? ['get'] : [];
		if (singularOps.length > 0) {
			if (definition.directGet) {
				properties.push(field('Entry / Request ID', 'entryId', 'string', singularOps, resource, {
					required: true,
					description: 'Exact entry identifier accepted by this form GET endpoint.',
				}));
			} else {
				const inputName = resource === 'incident' ? 'incidentNumber'
					: resource === 'company' ? 'companyEntryId'
					: resource === 'workOrder' || resource === 'workInfo' ? 'workOrderId'
					: resource === 'task' ? 'taskId'
					: resource === 'changeRequest' ? 'infrastructureChangeId'
					: 'workLogId';
				properties.push(field(definition.idLabel ?? 'Identifier', inputName, 'string', singularOps, resource, {
					required: true,
					description: `Value matched against the ${definition.idField} field; this is a business-field lookup, not a path entry ID.`,
				}));
			}
		}
	}

	properties.push(
		field('Company Name', 'companyName', 'string', ['getByName'], 'company', { required: true }),
		field('Entry / Request ID', 'entryId', 'string', ['update', 'setStatus', 'assign', 'resolve'], 'incident', {
			required: true,
			description: 'Endpoint entry identifier (normally the Request ID for incident mutations).',
		}),
		field('Entry / Request ID', 'entryId', 'string', ['update', 'setStatus'], 'company', {
			required: true,
			description: 'Endpoint entry identifier; the source update form uses Company Entry ID.',
		}),
		field('Entry / Request ID', 'entryId', 'string', ['update', 'setStatus'], 'workOrder', {
			required: true,
			description: 'Endpoint entry identifier. Update uses Request ID; status uses Work Order ID in the source API.',
		}),
		field('Entry / Request ID', 'entryId', 'string', ['update', 'setStatus'], 'task', {
			required: true,
			description: 'Endpoint entry identifier; the source task mutation uses Task ID.',
		}),
		field('Entry / Request ID', 'entryId', 'string', ['update', 'setStatus'], 'changeRequest', {
			required: true,
			description: 'Endpoint entry identifier (Infrastructure Change ID in the source API).',
		}),
		field('Entry / Request ID', 'entryId', 'string', ['update', 'setStatus'], 'workLog', {
			required: true,
			description: 'Endpoint entry identifier (Work Log ID).',
		}),
		field('Entry / Request ID', 'entryId', 'string', ['update'], 'workInfo', {
			required: true,
			description: 'Endpoint entry identifier (Request ID in the source API).',
		}),
	);

	for (const [resource, definition] of Object.entries(RESOURCES)) {
		if (definition.operations.includes('create') || definition.operations.includes('update')) {
			const operations = ['create', 'update'].filter(operation => definition.operations.includes(operation));
			properties.push(field('Fields JSON', 'fieldsJson', 'json', operations, resource, {
				default: '{}',
				description: 'Non-empty JSON object using exact Remedy field names; do not include a values envelope.',
			}));
		}
		if (definition.statusField && definition.statuses) {
			properties.push(field('Status', 'status', 'options', ['setStatus'], resource, {
				required: true,
				options: definition.statuses.map(value => ({ name: value, value })),
				default: definition.statuses[0],
			}));
		}
	}

	properties.push(
		field('Assigned Group', 'assignedGroup', 'string', ['getAssigned', 'getInProgress'], 'incident', { required: true }),
		field('Assignee', 'assignee', 'string', ['assign'], 'incident', { required: true }),
		field('Assignee Login ID', 'assigneeLoginId', 'string', ['assign'], 'incident', { required: true }),
		field('Resolution', 'resolution', 'string', ['resolve'], 'incident', { required: true }),
		field('Resolution Category', 'resolutionCategory', 'string', ['resolve'], 'incident', { required: true }),
		field('Resolution Category Tier 2', 'resolutionCategoryTier2', 'string', ['resolve'], 'incident', { required: true }),
		field('Resolution Category Tier 3', 'resolutionCategoryTier3', 'string', ['resolve'], 'incident', { required: true }),
	);

	for (const resource of ['incident', 'workOrder']) {
		const idName = resource === 'incident' ? 'incidentNumber' : 'workOrderId';
		const idLabel = resource === 'incident' ? 'Incident Number' : 'Work Order ID';
		properties.push(
			field(idLabel, idName, 'string', ['addComment'], resource, { required: true }),
			field('Detailed Description', 'detailedDescription', 'string', ['addComment'], resource, { required: true }),
			field('Work Log Type', 'workLogType', 'string', ['addComment'], resource, { default: 'General Information' }),
			field('View Access', 'viewAccess', 'string', ['addComment'], resource, { default: 'Public' }),
			field('Secure Work Log', 'secureWorkLog', 'string', ['addComment'], resource, { default: 'No' }),
			field(resource === 'incident' ? 'Entry / Request ID' : idLabel, resource === 'incident' ? 'entryId' : idName, 'string', ['uploadAttachment'], resource, {
				required: true,
				description: resource === 'incident' ? 'Endpoint entry identifier used by the IncidentInterface multipart PUT.' : 'Work Order ID linked to the new WorkInfo attachment.',
			}),
			field('Comment', 'comment', 'string', ['uploadAttachment'], resource, { required: true }),
			field('Binary Property Name', 'binaryPropertyName', 'string', ['uploadAttachment'], resource, { default: 'data' }),
			field('Filename', 'fileName', 'string', ['uploadAttachment'], resource, { default: '' }),
		);
	}
	properties.push(
		field('Work Order ID', 'workOrderId', 'string', ['getComments'], 'workOrder', { required: true }),
		field('Work Order ID', 'workOrderId', 'string', ['create'], 'workInfo', { required: true }),
		field('Detailed Description', 'detailedDescription', 'string', ['create'], 'workInfo', { required: true }),
		field('Work Log Type', 'workLogType', 'string', ['create'], 'workInfo', { default: 'General Information' }),
		field('View Access', 'viewAccess', 'string', ['create'], 'workInfo', { default: 'Public' }),
		field('Secure Work Log', 'secureWorkLog', 'string', ['create'], 'workInfo', { default: 'No' }),
	);

	properties.push(
		field('Incident Number', 'incidentNumber', 'string', ['getMany'], 'attachment', { required: true }),
		field('URL', 'url', 'string', ['download'], 'attachment', { required: true }),
		field('Binary Property Name', 'binaryPropertyName', 'string', ['download'], 'attachment', { default: 'data' }),
		field('Filename', 'fileName', 'string', ['download'], 'attachment', { default: '' }),
	);

	properties.push(
		field('Entry URL', 'entryUrl', 'string', ['extractEntryId'], 'helper', {
			required: true,
			description: 'Map _links.self[0].href or the create response location. This URL must identify a Remedy entry endpoint.',
		}),
		field('Description Fragments JSON', 'descriptionFragments', 'json', ['findOpenIncidentsByFragments'], 'helper', {
			required: true,
			default: '[]',
			description: 'JSON array of non-blank strings; at least one fragment is required. Description matching is case-sensitive.',
		}),
		field('Assigned Group', 'assignedGroup', 'string', ['findOpenIncidentsByFragments'], 'helper', { required: true }),
		field('Assigned Support Organization', 'assignedSupportOrganization', 'string', ['findOpenIncidentsByFragments'], 'helper', { required: true }),
		field('Since Days', 'sinceDays', 'number', ['findOpenIncidentsByFragments'], 'helper', { default: 1, typeOptions: { minValue: 0 } }),
		field('Description', 'description', 'string', ['findOpenIncidentByDescription', 'createEnrichedIncident'], 'helper', { required: true }),
		field('Since Days', 'sinceDays', 'number', ['findOpenIncidentByDescription'], 'helper', { default: 4, typeOptions: { minValue: 0 } }),
		field('Location ID', 'locationId', 'string', ['getPeopleFromSite'], 'helper', {
			required: true,
			description: 'Location ID used to find an enabled Remedy site.',
		}),
		field('Location ID', 'locationId', 'string', ['createEnrichedIncident'], 'helper', {
			default: 'S000001',
			description: 'Enabled Remedy site lookup key.',
		}),
		field('Location ID', 'locationId', 'string', ['createEnrichedWorkOrder'], 'helper', {
			required: true,
			description: 'Required enabled Remedy site lookup key.',
		}),
		field('Detailed Description', 'detailedDescription', 'string', ['createEnrichedIncident', 'createEnrichedWorkOrder'], 'helper', { default: '' }),
		field('Incident Options', 'incidentOptions', 'fixedCollection', ['createEnrichedIncident'], 'helper', {
			default: {},
			placeholder: 'Set visible incident defaults',
			typeOptions: { multipleValues: false },
			options: [{
				name: 'values',
				displayName: 'Values',
				values: [
					{ displayName: 'Assigned Group', name: 'assignedGroup', type: 'string', default: 'L1.7x24' },
					{ displayName: 'Assigned Support Company', name: 'assignedSupportCompany', type: 'string', default: 'BT España' },
					{ displayName: 'Assigned Support Organization', name: 'assignedSupportOrganization', type: 'string', default: 'GESTION PERSONALIZADA' },
					{ displayName: 'Categorization Tier 1', name: 'categorizationTier1', type: 'string', default: 'MONITORIZACION' },
					{ displayName: 'Categorization Tier 2', name: 'categorizationTier2', type: 'string', default: 'AUTOMATICA' },
					{ displayName: 'EVO Owner Gestion', name: 'evoOwnerGestion', type: 'string', default: 'L1.MCSMONITORIZACION' },
					{ displayName: 'Impact', name: 'impact', type: 'string', default: '4-Minor/Localized' },
					{ displayName: 'Product Categorization Tier 1', name: 'productTier1', type: 'string', default: 'IT SYSTEMS' },
					{ displayName: 'Product Categorization Tier 2', name: 'productTier2', type: 'string', default: 'PORTAL CLIENTE' },
					{ displayName: 'Product Categorization Tier 3', name: 'productTier3', type: 'string', default: 'PORTAL CLIENTE' },
					{ displayName: 'Reported Source', name: 'reportedSource', type: 'string', default: 'Alarma' },
					{ displayName: 'Service CI', name: 'serviceCI', type: 'string', default: '' },
					{ displayName: 'Service Type', name: 'serviceType', type: 'string', default: 'Infrastructure Event' },
					{ displayName: 'Urgency', name: 'urgency', type: 'string', default: '2-High' },
				],
			}],
		}),
		field('Fields JSON', 'fieldsJson', 'json', ['createEnrichedWorkOrder'], 'helper', {
			default: '{}',
			description: 'Optional exact WorkOrder form fields. Generated fields cannot be overridden.',
		}),
		field('Summary', 'summary', 'string', ['createEnrichedWorkOrder'], 'helper', { required: true }),
		field('Entry / Request ID', 'entryId', 'string', ['closeAlertIncident'], 'helper', {
			required: true,
			description: 'Incident endpoint entry identifier used by each sequential mutation.',
		}),
		field('Assignee', 'assignee', 'string', ['closeAlertIncident'], 'helper', { default: 'autobot autobot' }),
		field('Assignee Login ID', 'assigneeLoginId', 'string', ['closeAlertIncident'], 'helper', { default: 'autobot' }),
		field('Resolution', 'resolution', 'string', ['closeAlertIncident'], 'helper', { default: 'Alerta remite' }),
		field('Resolution Category', 'resolutionCategory', 'string', ['closeAlertIncident'], 'helper', { default: 'CUSTOMER' }),
		field('Resolution Category Tier 2', 'resolutionCategoryTier2', 'string', ['closeAlertIncident'], 'helper', { default: 'ACORDE A ESPECIFICACIONES' }),
		field('Resolution Category Tier 3', 'resolutionCategoryTier3', 'string', ['closeAlertIncident'], 'helper', { default: 'ACORDE AL SERVICIO CONTRATADO' }),
		field('Date Time', 'dateTime', 'string', ['getQueueForTime'], 'helper', {
			default: '',
			description: 'Optional date/time; defaults to execution time. With Time Zone set, include Z or a numeric offset.',
		}),
		field('Time Zone', 'timeZone', 'string', ['getQueueForTime'], 'helper', {
			default: '',
			description: 'Optional IANA time zone. Leave empty to use the host process timezone.',
		}),
	);


	return properties;
}

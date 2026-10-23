export interface ResourceDefinition {
	form: string;
	operations: string[];
	idField?: string;
	idLabel?: string;
	directGet?: boolean;
	createForm?: string;
	createIdField?: string;
	statusField?: string;
	statuses?: string[];
}

export const RESOURCES: Record<string, ResourceDefinition> = {
	incident: {
		form: 'HPD:IncidentInterface',
		operations: ['get', 'getMany', 'getAssigned', 'getInProgress', 'create', 'update', 'setStatus', 'assign', 'resolve', 'addComment', 'uploadAttachment'],
		idField: 'Incident Number',
		idLabel: 'Incident Number',
		createForm: 'HPD:IncidentInterface_Create',
		createIdField: 'Incident Number',
		statusField: 'Status',
		statuses: ['Assigned', 'In Progress', 'Closed', 'Cancelled', 'Pending', 'Resolved'],
	},
	site: { form: 'SIT:Site', operations: ['getMany'] },
	siteCompanyAssociation: { form: 'SIT:Site Company Association', operations: ['getMany'] },
	people: { form: 'CTM:People', operations: ['getMany'] },
	company: {
		form: 'COM:Company',
		operations: ['get', 'getByName', 'getMany', 'create', 'update', 'setStatus'],
		idField: 'Company Entry ID',
		idLabel: 'Company Entry ID',
		createForm: 'COM:Company',
		createIdField: 'Company Entry ID',
		statusField: 'Status',
		statuses: ['Enabled', 'Disabled'],
	},
	workOrder: {
		form: 'WOI:WorkOrderInterface',
		operations: ['get', 'getMany', 'create', 'update', 'setStatus', 'addComment', 'getComments', 'uploadAttachment'],
		idField: 'Work Order ID',
		idLabel: 'Work Order ID',
		createForm: 'WOI:WorkOrderInterface_Create',
		createIdField: 'WorkOrder_ID',
		statusField: 'Status',
		statuses: ['New', 'Assigned', 'In Progress', 'Pending', 'Resolved', 'Closed', 'Cancelled', 'Completed', 'Planning', 'Rejected', 'Waiting Approval'],
	},
	task: {
		form: 'TMS:Task',
		operations: ['get', 'getMany', 'create', 'update', 'setStatus'],
		idField: 'Task ID',
		idLabel: 'Task ID',
		createForm: 'TMS:Task',
		createIdField: 'Task ID',
		statusField: 'Status',
		statuses: ['Staged', 'Assigned', 'Pending', 'Work In Progress', 'Waiting', 'Closed', 'Bypassed'],
	},
	changeRequest: {
		form: 'CHG:ChangeInterface',
		operations: ['get', 'getMany', 'create', 'update', 'setStatus'],
		idField: 'Infrastructure Change ID',
		idLabel: 'Infrastructure Change ID',
		createForm: 'CHG:ChangeInterface',
		createIdField: 'Infrastructure Change ID',
		statusField: 'Change Request Status',
		statuses: ['Draft', 'Request For Authorization', 'Request For Change', 'Planning In Progress', 'Scheduled For Review', 'Scheduled For Approval', 'Scheduled', 'Implementation In Progress', 'Pending', 'Rejected', 'Completed', 'Closed', 'Cancelled'],
	},
	workLog: {
		form: 'HPD:WorkLog',
		operations: ['get', 'getMany', 'create', 'update', 'setStatus'],
		idField: 'Work Log ID',
		idLabel: 'Work Log ID',
		createForm: 'HPD:WorkLog',
		createIdField: 'Work Log ID',
		statusField: 'Status',
		statuses: ['Proposed', 'Enabled', 'Offline', 'Obsolete', 'Archive', 'Delete'],
	},
	workInfo: {
		form: 'WOI:WorkInfo',
		operations: ['get', 'getMany', 'create'],
		idField: 'Work Order ID',
		idLabel: 'Work Order ID',
		createForm: 'WOI:WorkInfo',
	},
	evoServer: { form: 'EVO:EVO_Server', operations: ['get', 'getMany'], directGet: true },
	evoMhcPublica: { form: 'AST:EVO_MHC_PUBLICA', operations: ['get', 'getMany'], directGet: true },
	attachment: { form: '', operations: ['getMany', 'download'] },
	helper: {
		form: '',
		operations: [
			'extractEntryId',
			'findOpenIncidentsByFragments',
			'findOpenIncidentByDescription',
			'getPeopleFromSite',
			'createEnrichedIncident',
			'createEnrichedWorkOrder',
			'closeAlertIncident',
			'getQueueForTime',
		],
	},
};

export const OPEN_INCIDENT_STATUSES = ['Assigned', 'Pending', 'In Progress'];

export const WORKLOG_COMMENT_DEFAULTS = {
	workLogType: 'General Information',
	viewAccess: 'Public',
	secureWorkLog: 'No',
};

export const INCIDENT_STATUS_PROJECTION = [
	'Description',
	'Detailed Decription',
	'Incident Number',
	'Request ID',
	'Impact',
	'Status',
	'Status_Reason',
	'Resolution',
	'Assignee',
	'Submit Date',
	'Vendor Incidencia Number',
	'Site',
].join(',');

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { Remedy } = require('../dist/nodes/Remedy/Remedy.node.js');
const { RemedyApi } = require('../dist/credentials/RemedyApi.credentials.js');
const { RemedyClient, remedyApiTest } = require('../dist/transport/RemedyClient.js');
const { readPagingOptions } = require('../dist/execute/pagination.js');
const { CREDENTIALS, createContext, login, response } = require('./helpers/mockContext.js');

process.env.TZ = 'UTC';

function entry(values, extra = {}) {
	return { values, _links: { self: [{ href: 'https://remedy.example.test/api/arsys/v1/entry/Example/ENTRY-1' }] }, ...extra };
}

function list(...entries) {
	return { entries };
}

function run(params, responses = [], options = {}) {
	const context = createContext({ params, responses, ...options });
	return { context, promise: new Remedy().execute.call(context) };
}

test('credential test passes form fields as an object to n8n request helper', async () => {
	const credential = new RemedyApi();
	assert.equal(credential.name, 'remedyApi');
	assert.equal(credential.displayName, 'Remedy API');
	const node = new Remedy();
	assert.equal(node.description.name, 'remedy');
	assert.equal(node.description.credentials[0].testedBy, 'remedyApiTest');
	let request;
	const result = await remedyApiTest.call({
		helpers: {
			request: async (url, options) => {
				request = { url, options };
				return response('fresh-jwt', 200);
			},
		},
	}, { data: CREDENTIALS });
	assert.deepEqual(result, { status: 'OK', message: 'Connection successful' });
	assert.equal(request.url, 'https://remedy.example.test/api/jwt/login');
	assert.equal(request.options.method, 'POST');
	assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
	assert.deepEqual(request.options.form, { username: CREDENTIALS.username, password: CREDENTIALS.password });
	assert.equal(request.options.resolveWithFullResponse, true);
	assert.equal(request.options.timeout, 30000);
	assert.equal(request.options.rejectUnauthorized, true);
	assert.equal(Object.hasOwn(request.options, 'Authorization'), false);
});

test('login rejection stops before the resource request and never exposes form credentials', async () => {
	const { context, promise } = run({ resource: 'site', operation: 'getMany' }, [response('login denied', 401)]);
	await assert.rejects(promise, error => {
		assert.match(error.message, /HTTP 401/);
		assert.doesNotMatch(error.message, /secret-value|automation user/);
		return true;
	});
	assert.equal(context.requests.length, 1);
	assert.equal(context.requests[0].url, 'https://remedy.example.test/api/jwt/login');
	assert.equal(context.requests[0].body.toString(), 'username=automation+user&password=secret-value');
});
test('returned HTTP error bodies redact the execution token and credentials', async () => {
	const params = { resource: 'site', operation: 'getMany' };
	const errorBody = JSON.stringify({ message: 'execution-token secret-value automation user' });
	const { context, promise } = run(params, [login('execution-token'), response(errorBody, 500)]);
	await assert.rejects(promise, error => {
		assert.match(error.message, /HTTP 500/);
		assert.doesNotMatch(error.message, /execution-token|secret-value|automation user/);
		return true;
	});

	const continued = run(params, [login('execution-token'), response(errorBody, 500)], { continueOnFail: true });
	const [outputs] = await continued.promise;
	assert.doesNotMatch(outputs[0].json.error, /execution-token|secret-value|automation user/);

	const nestedError = Object.assign(new Error('request failed'), {
		response: response(errorBody, 500),
	});
	const thrown = run(params, [login('execution-token'), nestedError]);
	await assert.rejects(thrown.promise, error => {
		assert.match(error.message, /HTTP 500/);
		assert.doesNotMatch(error.message, /execution-token|secret-value|automation user/);
		return true;
	});
	assert.equal(context.requests.length, 2);
});

test('runtime login and authenticated redirects are rejected without following', async () => {
	const loginRedirect = run({ resource: 'site', operation: 'getMany' }, [response('redirect', 307)]);
	await assert.rejects(loginRedirect.promise, /login failed with HTTP 307/i);
	assert.equal(loginRedirect.context.requests.length, 1);
	assert.equal(loginRedirect.context.requests[0].disableFollowRedirect, true);

	for (const [params, status] of [
		[{ resource: 'site', operation: 'getMany' }, 302],
		[{ resource: 'incident', operation: 'update', entryId: 'S-1', fieldsJson: { Name: 'Updated' } }, 307],
	]) {
		const redirected = run(params, [login(), response('redirect', status)]);
		await assert.rejects(redirected.promise, new RegExp(`HTTP ${status}`));
		assert.equal(redirected.context.requests.length, 2);
		assert.equal(redirected.context.requests[0].disableFollowRedirect, true);
		assert.equal(redirected.context.requests[1].disableFollowRedirect, true);
	}
});


test('one execution reuses one token and preserves item pairing across list results', async () => {
	const inputs = [{}, {}];
	const params = [
		{ resource: 'site', operation: 'getMany' },
		{ resource: 'site', operation: 'getMany' },
	];
	const { context, promise } = run(params, [
		login('execution-token'),
		response(list(entry({ 'Site ID': 'S1' }), entry({ 'Site ID': 'S2' }))),
		response(list(entry({ 'Site ID': 'S3' }))),
	], { inputs });
	const [outputs] = await promise;
	assert.equal(context.credentialsReads, 1);
	assert.equal(context.requests.length, 3);
	assert.deepEqual(context.requests.slice(1).map(request => request.headers.Authorization), [
		'AR-JWT execution-token',
		'AR-JWT execution-token',
	]);
	assert.deepEqual(outputs.map(item => item.json.values['Site ID']), ['S1', 'S2', 'S3']);
	assert.deepEqual(outputs.map(item => item.pairedItem), [{ item: 0 }, { item: 0 }, { item: 1 }]);
});

test('qualification filters quote literals and leave absent query parameters out', async () => {
	const params = {
		resource: 'people',
		operation: 'getMany',
		filters: { filter: [{ field: "Company's\\ Unit", operator: '>=', value: 'München >= "North" \\west' }] },
		fields: 'Remedy Login ID,First Name',
		limit: 25,
		offset: 7,
	};
	const { context, promise } = run(params, [login(), response(list())]);
	await promise;
	const query = context.requests[1].qs;
	assert.equal(query.q, "'Company\\'s\\\\ Unit' >= \"München >= \\\"North\\\" \\\\west\"");
	assert.equal(query.fields, 'values(Remedy Login ID,First Name)');
	assert.equal(query.limit, 25);
	assert.equal(query.offset, 7);

	const omitted = run({ resource: 'site', operation: 'getMany' }, [login(), response(list())]);
	await omitted.promise;
	assert.equal(Object.hasOwn(omitted.context.requests[1], 'qs'), false);
});

test('qualification and non-empty structured filters are rejected locally', async () => {
	const { context, promise } = run({
		resource: 'site',
		operation: 'getMany',
		qualification: "'Status' == \"Enabled\"",
		filters: { filter: [{ field: 'Status', operator: '==', value: 'Enabled' }] },
	});
	await assert.rejects(promise, /cannot be combined/i);
	assert.equal(context.requests.length, 0);
});

test('getMany uses the exact read form for every implemented resource form', async () => {
	const forms = [
		['incident', 'HPD:IncidentInterface'],
		['site', 'SIT:Site'],
		['siteCompanyAssociation', 'SIT:Site Company Association'],
		['people', 'CTM:People'],
		['company', 'COM:Company'],
		['workOrder', 'WOI:WorkOrderInterface'],
		['task', 'TMS:Task'],
		['changeRequest', 'CHG:ChangeInterface'],
		['workLog', 'HPD:WorkLog'],
		['workInfo', 'WOI:WorkInfo'],
		['evoServer', 'EVO:EVO_Server'],
		['evoMhcPublica', 'AST:EVO_MHC_PUBLICA'],
	];
	const inputs = forms.map(() => ({}));
	const params = forms.map(([resource]) => ({ resource, operation: 'getMany' }));
	const responses = [login(), ...forms.map(() => response(list()))];
	const { context, promise } = run(params, responses, { inputs });
	const [outputs] = await promise;
	assert.deepEqual(outputs, []);
	assert.deepEqual(context.requests.slice(1).map(request => request.url), forms.map(([, form]) =>
		`https://remedy.example.test/api/arsys/v1/entry/${encodeURIComponent(form)}`));
	assert.equal(context.requests[1].qs, undefined);
});

test('create operations send exact fields and form-specific returned-field projections', async () => {
	const cases = [
		['incident', 'HPD:IncidentInterface_Create', 'Incident Number'],
		['company', 'COM:Company', 'Company Entry ID'],
		['workOrder', 'WOI:WorkOrderInterface_Create', 'WorkOrder_ID'],
		['task', 'TMS:Task', 'Task ID'],
		['changeRequest', 'CHG:ChangeInterface', 'Infrastructure Change ID'],
		['workLog', 'HPD:WorkLog', 'Work Log ID'],
	];
	const inputs = cases.map(() => ({}));
	const params = cases.map(([resource]) => ({
		resource,
		operation: 'create',
		fieldsJson: { Status: false, Count: 0, Custom_Field: null },
	}));
	const { context, promise } = run(params, [login(), ...cases.map(() => response({ values: { created: true } }, 201))], { inputs });
	const [outputs] = await promise;
	assert.equal(outputs.length, cases.length);
	for (let index = 0; index < cases.length; index++) {
		const [, form, returnedField] = cases[index];
		const request = context.requests[index + 1];
		assert.equal(request.method, 'POST');
		assert.equal(request.url, `https://remedy.example.test/api/arsys/v1/entry/${encodeURIComponent(form)}`);
		assert.equal(request.qs.fields, `values(${returnedField})`);
		assert.deepEqual(request.body, { values: { Status: false, Count: 0, Custom_Field: null } });
		assert.deepEqual(outputs[index].json, { values: { created: true } });
	}
});

test('WorkInfo create merges required typed fields and allows empty additional JSON', async () => {
	const { context, promise } = run({
		resource: 'workInfo',
		operation: 'create',
		workOrderId: 'WO-1',
		detailedDescription: 'comment',
		fieldsJson: {},
	}, [login(), response('', 201)]);
	const [outputs] = await promise;
	assert.deepEqual(context.requests[1].body, {
		values: {
			'Detailed Description': 'comment',
			'Work Order ID': 'WO-1',
			'Work Log Type': 'General Information',
			'View Access': 'Public',
			'Secure Work Log': 'No',
		},
	});
	assert.equal(Object.hasOwn(context.requests[1], 'qs'), false);
	assert.deepEqual(outputs[0].json, { success: true, resource: 'workInfo', operation: 'create' });
});

test('fields JSON rejects arrays, invalid JSON, empty ordinary objects, and a values envelope before login', async () => {
	for (const fieldsJson of ['{bad', '[]', '{}', { values: { Status: 'New' } }]) {
		const { context, promise } = run({ resource: 'incident', operation: 'create', fieldsJson });
		await assert.rejects(promise);
		assert.equal(context.requests.length, 0);
	}
});

test('singular business lookup and path update keep identifiers separate and encode the path once', async () => {
	const inputs = [{}, {}];
	const params = [
		{ resource: 'incident', operation: 'get', incidentNumber: 'INC0001' },
		{ resource: 'incident', operation: 'update', entryId: 'REQ|A/1', fieldsJson: { Status: 'Pending' } },
	];
	const { context, promise } = run(params, [
		login(),
		response(list(entry({ 'Incident Number': 'INC0001' }))),
		response('', 204),
	], { inputs });
	const [outputs] = await promise;
	assert.equal(context.requests[1].url, 'https://remedy.example.test/api/arsys/v1/entry/HPD%3AIncidentInterface');
	assert.equal(context.requests[1].qs.q, "'Incident Number' == \"INC0001\"");
	assert.equal(context.requests[2].url, 'https://remedy.example.test/api/arsys/v1/entry/HPD%3AIncidentInterface/REQ%7CA%2F1');
	assert.deepEqual(context.requests[2].body, { values: { Status: 'Pending' } });
	assert.deepEqual(outputs.map(item => item.pairedItem), [{ item: 0 }, { item: 1 }]);
	assert.deepEqual(outputs[1].json, { success: true, resource: 'incident', operation: 'update', entryId: 'REQ|A/1' });
});

test('direct EVO asset get validates a values object and uses an encoded entry path', async () => {
	const { context, promise } = run({ resource: 'evoServer', operation: 'get', entryId: 'server/α' }, [
		login(),
		response(entry({ Name: 'server' })),
	]);
	const [outputs] = await promise;
	assert.equal(context.requests[1].url, 'https://remedy.example.test/api/arsys/v1/entry/EVO%3AEVO_Server/server%2F%CE%B1');
	assert.deepEqual(outputs[0].json.values, { Name: 'server' });
});

test('bodyless status writes use the exact status field and return success metadata', async () => {
	const { context, promise } = run({
		resource: 'changeRequest',
		operation: 'setStatus',
		entryId: 'CR-1',
		status: 'Implementation In Progress',
	}, [login(), response('', 204)]);
	const [outputs] = await promise;
	assert.deepEqual(context.requests[1].body, { values: { 'Change Request Status': 'Implementation In Progress' } });
	assert.deepEqual(outputs[0].json, { success: true, resource: 'changeRequest', operation: 'setStatus', entryId: 'CR-1' });
});

test('create without a response body returns the actual Location header', async () => {
	const { context, promise } = run({
		resource: 'task',
		operation: 'create',
		fieldsJson: { Summary: 'new task' },
	}, [login(), response('', 201, { Location: '/api/arsys/v1/entry/TMS%3ATask/ID-1' })]);
	const [outputs] = await promise;
	assert.deepEqual(outputs[0].json, {
		success: true,
		resource: 'task',
		operation: 'create',
		location: '/api/arsys/v1/entry/TMS%3ATask/ID-1',
	});
	assert.deepEqual(context.requests[1].body, { values: { Summary: 'new task' } });
});

test('continue-on-fail keeps processing subsequent items and pairs the error to its source', async () => {
	const inputs = [{}, {}];
	const params = [
		{ resource: 'site', operation: 'getMany' },
		{ resource: 'site', operation: 'getMany' },
	];
	const { context, promise } = run(params, [login(), response({ message: 'denied' }, 403), response(list(entry({ 'Site ID': 'S2' })))], {
		inputs,
		continueOnFail: true,
	});
	const [outputs] = await promise;
	assert.equal(outputs.length, 2);
	assert.match(outputs[0].json.error, /HTTP 403/);
	assert.deepEqual(outputs.map(item => item.pairedItem), [{ item: 0 }, { item: 1 }]);
	assert.equal(outputs[1].json.values['Site ID'], 'S2');
	assert.equal(context.requests.length, 3);
});

test('malformed list and direct-entry response shapes are surfaced as API errors', async () => {
	const malformedList = run({ resource: 'site', operation: 'getMany' }, [login(), response({ entries: [{ values: [] }] })]);
	await assert.rejects(malformedList.promise, /malformed entry/i);
	const malformedEntry = run({ resource: 'evoServer', operation: 'get', entryId: 'id' }, [login(), response({ values: [] })]);
	await assert.rejects(malformedEntry.promise, /invalid entry response/i);
});

test('incident assignment and resolution preserve the Remedy wire field names', async () => {
	const inputs = [{}, {}];
	const params = [
		{ resource: 'incident', operation: 'assign', entryId: 'REQ-1', assignee: 'A Person', assigneeLoginId: 'aperson' },
		{
			resource: 'incident', operation: 'resolve', entryId: 'REQ-2', resolution: 'fixed',
			resolutionCategory: 'CUSTOMER', resolutionCategoryTier2: 'T2', resolutionCategoryTier3: 'T3',
		},
	];
	const { context, promise } = run(params, [login(), response('', 204), response('', 204)], { inputs });
	const [outputs] = await promise;
	assert.deepEqual(context.requests[1].body, { values: { Assignee: 'A Person', 'Assignee Login ID': 'aperson' } });
	assert.deepEqual(context.requests[2].body, { values: {
		Status: 'Resolved',
		Status_Reason: 'Automated Resolution Reported',
		Resolution: 'fixed',
		'Resolution Category': 'CUSTOMER',
		'Resolution Category Tier 2': 'T2',
		'Resolution Category Tier 3': 'T3',
	} });
	assert.deepEqual(outputs.map(item => item.json.success), [true, true]);
});

test('incident comments, WorkOrder comments, and WorkOrder comment listing use their actual forms', async () => {
	const inputs = [{}, {}, {}];
	const params = [
		{ resource: 'incident', operation: 'addComment', incidentNumber: 'INC-1', detailedDescription: 'incident note' },
		{ resource: 'workOrder', operation: 'addComment', workOrderId: 'WO-1', detailedDescription: 'work note' },
		{ resource: 'workOrder', operation: 'getComments', workOrderId: 'WO-1' },
	];
	const { context, promise } = run(params, [login(), response('', 201), response('', 201), response(list(entry({ 'Work Order ID': 'WO-1' })))], { inputs });
	const [outputs] = await promise;
	assert.equal(context.requests[1].url, 'https://remedy.example.test/api/arsys/v1/entry/HPD%3AWorkLog');
	assert.deepEqual(context.requests[1].body, { values: {
		'Detailed Description': 'incident note',
		'Incident Number': 'INC-1',
		'Work Log Type': 'General Information',
		'View Access': 'Public',
		'Secure Work Log': 'No',
	} });
	assert.equal(context.requests[2].url, 'https://remedy.example.test/api/arsys/v1/entry/WOI%3AWorkInfo');
	assert.deepEqual(context.requests[2].body.values, {
		'Detailed Description': 'work note',
		'Work Order ID': 'WO-1',
		'Work Log Type': 'General Information',
		'View Access': 'Public',
		'Secure Work Log': 'No',
	});
	assert.equal(context.requests[3].qs.q, "'Work Order ID' == \"WO-1\"");
	assert.equal(outputs.length, 3);
});

test('attachment listing combines both sources, skips null slots, and includes available identifiers', async () => {
	const worklog = entry({
		'Work Log ID': 'WL-1',
		'z2AF Work Log01': { name: 'note.txt', href: '/api/files/note.txt', sizeBytes: 9 },
		'z2AF Work Log02': null,
		'z2AF Work Log03': { name: 'second.txt', href: '/api/files/second.txt' },
	});
	const cfg = entry({
		'CFG Attachment ID': 'CFG-9',
		'z2AF Work Log01': { name: 'incident.eml', href: '/api/files/mail.eml', sizeBytes: 12 },
	});
	const { context, promise } = run({ resource: 'attachment', operation: 'getMany', incidentNumber: 'INC/1' }, [
		login(), response(list(worklog)), response(list(cfg)),
	]);
	const [outputs] = await promise;
	assert.equal(outputs.length, 3);
	assert.deepEqual(outputs.map(item => item.json), [
		{ name: 'note.txt', url: '/api/files/note.txt', sizeBytes: 9, type: 'worklog', workLogId: 'WL-1' },
		{ name: 'second.txt', url: '/api/files/second.txt', sizeBytes: 0, type: 'worklog', workLogId: 'WL-1' },
		{ name: 'incident.eml', url: '/api/files/mail.eml', sizeBytes: 12, type: 'incident', attachmentId: 'CFG-9' },
	]);
	assert.equal(context.requests[1].qs.q, "'Incident Number' == \"INC/1\"");
	assert.equal(context.requests[1].qs.fields, 'values(z2AF Work Log01,z2AF Work Log02,z2AF Work Log03,Work Log ID)');
	assert.equal(context.requests[2].qs.q, "'Request ID01' == \"INC/1\"");
});

test('attachment listing does not conceal a failed second source', async () => {
	const { context, promise } = run({ resource: 'attachment', operation: 'getMany', incidentNumber: 'INC-1' }, [
		login(), response(list(entry({}))), response({ message: 'CFG unavailable' }, 503),
	]);
	await assert.rejects(promise, /HTTP 503/);
	assert.equal(context.requests.length, 3);
});

test('multipart uploads preserve exact bytes and Remedy part names for both forms', async () => {
	const bytes = Buffer.from([0x00, 0x01, 0xff, 0x41]);
	const inputs = [
		{ binary: { data: { buffer: bytes, fileName: 'résumé.eml', mimeType: 'message/rfc822' } } },
		{ binary: { data: { buffer: bytes, fileName: 'résumé.eml', mimeType: 'message/rfc822' } } },
	];
	const params = [
		{ resource: 'incident', operation: 'uploadAttachment', entryId: 'REQ-1', comment: 'incident file', binaryPropertyName: 'data' },
		{ resource: 'workOrder', operation: 'uploadAttachment', workOrderId: 'WO-1', comment: 'work file', binaryPropertyName: 'data' },
	];
	const { context, promise } = run(params, [login(), response('', 204), response('', 201)], { inputs });
	const [outputs] = await promise;
	assert.equal(outputs.length, 2);
	for (const request of context.requests.slice(1)) {
		assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/i);
		const body = request.body.getBuffer();
		assert.equal(body.includes(bytes), true);
		assert.equal(body.includes(Buffer.from('résumé.eml')), true);
		assert.equal(body.includes(Buffer.from('application/json; charset=UTF-8')), true);
	}
	const incidentBody = context.requests[1].body.getBuffer().toString('latin1');
	assert.match(incidentBody, /name="entry"/);
	assert.match(incidentBody, /name="attach-z2AF_Act_Attachment_1"/);
	assert.match(incidentBody, /"z1D Action":"MODIFY"/);
	const workBody = context.requests[2].body.getBuffer().toString('latin1');
	assert.match(workBody, /name="attach-z2AF Work Log01"/);
	assert.match(workBody, /"Work Order ID":"WO-1"/);
});

test('attachment download returns identical binary and rejects foreign URLs and redirects', async () => {
	const bytes = Buffer.from([0x00, 0x01, 0xff, 0x41]);
	const { context, promise } = run({
		resource: 'attachment', operation: 'download', url: '/api/attachments/r%C3%A9sum%C3%A9.eml',
		binaryPropertyName: 'downloaded',
	}, [login(), response(bytes, 200, { 'Content-Type': 'message/rfc822' })]);
	const [outputs] = await promise;
	assert.deepEqual(Buffer.from(outputs[0].binary.downloaded.data, 'base64'), bytes);
	assert.equal(outputs[0].binary.downloaded.fileName, 'résumé.eml');
	assert.equal(outputs[0].binary.downloaded.mimeType, 'message/rfc822');
	assert.equal(context.requests[1].encoding, 'arraybuffer');
	assert.equal(context.requests[1].disableFollowRedirect, true);

	const foreign = run({ resource: 'attachment', operation: 'download', url: 'https://foreign.example/api/file' });
	await assert.rejects(foreign.promise, /configured Remedy origin/i);
	assert.equal(foreign.context.requests.length, 0);

	const redirect = run({ resource: 'attachment', operation: 'download', url: '/api/file' }, [login(), response('', 302, { location: 'https://foreign.example/file' })]);
	await assert.rejects(redirect.promise, /HTTP 302/);
	assert.equal(redirect.context.requests.length, 2);
	assert.equal(new URL(redirect.context.requests[1].url).origin, new URL(CREDENTIALS.baseUrl).origin);
	assert.equal(redirect.context.requests[1].disableFollowRedirect, true);
});

test('open-incident fragment search uses a strict process-local second-precision cutoff', async () => {
	const originalNow = Date.now;
	Date.now = () => Date.UTC(2025, 0, 2, 12, 34, 56);
	try {
		const { context, promise } = run({
			resource: 'helper', operation: 'findOpenIncidentsByFragments',
			descriptionFragments: ['ALERT', 'proxy'],
			assignedGroup: 'L1', assignedSupportOrganization: 'OPS', sinceDays: 1,
		}, [login(), response(list(
			entry({ Description: 'ALERT down', Status: 'Assigned' }),
			entry({ Description: 'ALERT closed', Status: 'Closed' }),
			entry({ Status: 'Pending' }),
			entry({ Description: 'Proxy down', Status: 'In Progress' }),
		))]);
		const [outputs] = await promise;
		assert.deepEqual(outputs.map(item => item.json.values.Description), ['ALERT down']);
		assert.equal(context.requests[1].qs.q,
			"'Assigned Group' == \"L1\" AND 'Assigned Support Organization' == \"OPS\" AND 'Last Modified Date' > \"2025-01-01T12:34:56\"");
	} finally {
		Date.now = originalNow;
	}
});

test('exact-description search returns the first open exact match only', async () => {
	const originalNow = Date.now;
	Date.now = () => Date.UTC(2025, 0, 5, 0, 0, 0);
	try {
		const { context, promise } = run({
			resource: 'helper', operation: 'findOpenIncidentByDescription', description: 'A "quoted" alert', sinceDays: 4,
		}, [login(), response(list(
			entry({ Description: 'A "quoted" alert', Status: 'Closed' }),
			entry({ Description: 'A "quoted" alert!', Status: 'Assigned' }),
			entry({ Description: 'A "quoted" alert', Status: 'Pending', marker: 1 }),
			entry({ Description: 'A "quoted" alert', Status: 'In Progress', marker: 2 }),
		))]);
		const [outputs] = await promise;
		assert.equal(outputs.length, 1);
		assert.equal(outputs[0].json.values.marker, 1);
		assert.equal(context.requests[1].qs.q, "'Description' == \"A \\\"quoted\\\" alert\" AND 'Last Modified Date' > \"2025-01-01T00:00:00\"");
	} finally {
		Date.now = originalNow;
	}
});

test('getPeopleFromSite normalizes helper-only reads and preserves the full People entry', async () => {
	const person = entry({ 'Remedy Login ID': 'ORG-2/user', 'First Name': 'Ada' }, { customMeta: 'kept' });
	const { context, promise } = run({ resource: 'helper', operation: 'getPeopleFromSite', locationId: 'LOC-1' }, [
		login(),
		response(list(entry({ 'Location ID': 'LOC-1', 'Site ID': 'EMPTY', EVO_cs_orgid: '' }), entry({ 'Location ID': 'LOC-1', 'Site ID': 'SITE-2', EVO_cs_orgid: 'ORG-2' }))),
		response(list(entry({ 'Site ID': 'SITE-2', Company: 'Company A' }))),
		response(list(person)),
	]);
	const [outputs] = await promise;
	assert.deepEqual(outputs[0].json, person);
	assert.equal(context.requests[1].qs.q, "'Location ID' == \"LOC-1\" AND 'Status' == \"Enabled\"");
	assert.equal(context.requests[2].qs.q, "'Site ID' == \"SITE-2\"");
	assert.equal(context.requests[3].qs.q, "'Remedy Login ID' LIKE \"ORG-2/%\"");
});

test('enriched incident performs one create and refetches the returned Incident Number', async () => {
	const originalSetTimeout = global.setTimeout;
	const waits = [];
	global.setTimeout = (callback, milliseconds, ...args) => {
		waits.push(milliseconds);
		return originalSetTimeout(callback, 0, ...args);
	};
	try {
		const site = entry({ 'Location ID': 'LOC-1', 'Site ID': 'SITE-1', Site: 'Site One', 'State Province': 'State' });
		const association = entry({ Company: 'Customer A' });
		const company = entry({ Company: 'Customer A', Company_ID: 'CUST' });
		const people = entry({ first_name: 'Ada', last_name: 'Lovelace', default_country: 'ES', default_city: 'Madrid' });
		const created = { values: { 'Incident Number': 'INC-NEW' } };
		const fetched = entry({ 'Incident Number': 'INC-NEW', Description: 'returned' });
		const { context, promise } = run({
			resource: 'helper', operation: 'createEnrichedIncident',
			description: 'Alarm', detailedDescription: 'Full report', locationId: 'LOC-1',
			incidentOptions: { values: { assignedGroup: 'OVERRIDE-GROUP', serviceCI: 'CI-1' } },
		}, [login(), response(list(site)), response(list(association)), response(list(company)), response(list(people)), response(created, 201), response(list(fetched))]);
		const [outputs] = await promise;
		assert.equal(outputs[0].json.values['Incident Number'], 'INC-NEW');
		assert.deepEqual(waits, [2000]);
		assert.equal(context.requests.length, 7);
		assert.equal(context.requests.filter(request => request.method === 'POST' && !request.url.endsWith('/jwt/login')).length, 1);
		const fields = context.requests[5].body.values;
		assert.equal(fields.First_Name, 'Ada');
		assert.equal(fields.Last_Name, 'Lovelace');
		assert.equal(fields['Default Country'], 'ES');
		assert.equal(fields['Default City'], 'Madrid');
		assert.equal(fields['State Province'], 'State');
		assert.equal(fields['Site ID'], 'SITE-1');
		assert.equal(fields.Site, 'Site One');
		assert.equal(fields.Company, 'Customer A');
		assert.equal(fields.Description, 'Alarm');
		assert.equal(fields.Detailed_Decription, 'Full report');
		assert.equal(fields.Status, 'New');
		assert.equal(fields['Assigned Group'], 'OVERRIDE-GROUP');
		assert.equal(fields.ServiceCI, 'CI-1');
		assert.equal(context.requests[6].qs.q, "'Incident Number' == \"INC-NEW\"");
	} finally {
		global.setTimeout = originalSetTimeout;
	}
});

test('enriched incident truncates descriptions by Unicode code point and omits unset Service CI', async () => {
	const originalSetTimeout = global.setTimeout;
	global.setTimeout = (callback, _milliseconds, ...args) => originalSetTimeout(callback, 0, ...args);
	try {
		const site = entry({ 'Site ID': 'S1', Site: 'Site' });
		const association = entry({ Company: 'Company' });
		const company = entry({ Company: 'Company', Company_ID: 'C' });
		const people = entry({ 'First Name': 'A', 'Last Name': 'B' });
		const responseBody = { values: { 'Incident Number': 'INC-1' } };
		const { context, promise } = run({ resource: 'helper', operation: 'createEnrichedIncident', description: 'é'.repeat(91), locationId: 'LOC' }, [
			login(), response(list(site)), response(list(association)), response(list(company)), response(list(people)), response(responseBody, 201), response(list(entry({ 'Incident Number': 'INC-1' }))),
		]);
		await promise;
		const fields = context.requests[5].body.values;
		assert.equal(Array.from(fields.Description).length, 85);
		assert.equal(Object.hasOwn(fields, 'ServiceCI'), false);
	} finally {
		global.setTimeout = originalSetTimeout;
	}
});

test('enriched work order requires its location, keeps site defaults out, and truncates summaries at 85 code points', async () => {
	const site = entry({ 'Site ID': 'S1', Site: 'Site One' });
	const association = entry({ Company: 'Customer A' });
	const company = entry({ Company: 'Customer A', Company_ID: 'CUST', Company: 'Customer A' });
	const people = entry({ 'First Name': 'Ada', 'Last Name': 'Lovelace' });
	const { context, promise } = run({
		resource: 'helper', operation: 'createEnrichedWorkOrder', summary: 'S'.repeat(91), locationId: 'LOC-1',
		detailedDescription: 'details', fieldsJson: { EVO_Owner_Gestion: false, Priority: 0, Extra_Field: null },
	}, [login(), response(list(site)), response(list(association)), response(list(company)), response(list(people)), response({ values: { WorkOrder_ID: 'WO-1' } }, 201)]);
	const [outputs] = await promise;
	const fields = context.requests[5].body.values;
	assert.equal(fields.Company, 'Customer A');
	assert.equal(fields['Customer Company'], 'Customer A');
	assert.equal(fields['Customer First Name'], 'Ada');
	assert.equal(fields['Customer Last Name'], 'Lovelace');
	assert.equal(fields['Location Company'], 'Customer A');
	assert.equal(fields.Site, 'Site One');
	assert.equal(fields['Detailed Description'], 'details');
	assert.equal(Array.from(fields.Summary).length, 85);
	assert.equal(fields.EVO_Owner_Gestion, false);
	assert.equal(fields.Priority, 0);
	assert.equal(fields.Extra_Field, null);
	assert.equal(Object.hasOwn(fields, 'EVO_Service_Type'), false);
	assert.deepEqual(outputs[0].json, { values: { WorkOrder_ID: 'WO-1' } });
	assert.equal(context.requests[5].qs.fields, 'values(WorkOrder_ID)');
});

test('missing enrichment People stops before any create POST', async () => {
	const site = entry({ 'Site ID': 'S1' });
	const association = entry({ Company: 'Customer A' });
	const company = entry({ Company: 'Customer A', Company_ID: 'CUST' });
	const { context, promise } = run({
		resource: 'helper', operation: 'createEnrichedWorkOrder', summary: 'Summary', locationId: 'LOC',
	}, [login(), response(list(site)), response(list(association)), response(list(company)), response(list())]);
	await assert.rejects(promise, /People lookup.*Company ID CUST/i);
	assert.equal(context.requests.some(request => request.method === 'POST' && !request.url.endsWith('/jwt/login')), false);
});

test('alert closure stops at each failed stage and warns before retry', async () => {
	const stages = [
		{ name: 'assign', completed: 'none', responses: [response({ message: 'execution-token secret-value automation user' }, 500)], writes: 0 },
		{ name: 'resolve', completed: 'assign', responses: [response('', 204), response({ message: 'execution-token secret-value automation user' }, 500)], writes: 1 },
		{ name: 'close', completed: 'assign, resolve', responses: [response('', 204), response('', 204), response({ message: 'execution-token secret-value automation user' }, 500)], writes: 2 },
	];
	for (const stage of stages) {
		const { context, promise } = run({
			resource: 'helper', operation: 'closeAlertIncident', entryId: 'REQ-1',
		}, [login('execution-token'), ...stage.responses]);
		await assert.rejects(promise, error => {
			assert.ok(error.message.includes(`failed at ${stage.name}`));
			assert.ok(error.message.includes(`completed stages: ${stage.completed}.`));
			assert.ok(error.message.includes('Completed stages are acknowledged successes; the failed stage may have taken effect. Verify the record before retrying.'));
			assert.doesNotMatch(error.message, /execution-token|secret-value|automation user/);
			assert.equal(error.httpCode, '500');
			return true;
		});
		assert.equal(context.requests.length, stage.writes + 2);
		assert.equal(context.requests.slice(1).filter(request => request.method === 'PUT').length, stage.writes + 1);
	}
});

test('enriched incident empty and failed follow-up reads report the created number without another POST', async () => {
	const originalSetTimeout = global.setTimeout;
	global.setTimeout = (callback, _milliseconds, ...args) => originalSetTimeout(callback, 0, ...args);
	try {
		const site = entry({ 'Location ID': 'LOC-1', 'Site ID': 'SITE-1', Site: 'Site One' });
		const association = entry({ Company: 'Customer A' });
		const company = entry({ Company: 'Customer A', Company_ID: 'CUST' });
		const people = entry({ 'First Name': 'Ada', 'Last Name': 'Lovelace' });
		const created = response({ values: { 'Incident Number': 'INC-NEW' } }, 201);
		for (const followUp of [response(list()), response({ message: 'execution-token secret-value' }, 500)]) {
			const { context, promise } = run({
				resource: 'helper', operation: 'createEnrichedIncident',
				description: 'Alarm', locationId: 'LOC-1',
			}, [login('execution-token'), response(list(site)), response(list(association)), response(list(company)), response(list(people)), created, followUp]);
			await assert.rejects(promise, error => {
				assert.match(error.message, /created INC-NEW/);
				assert.doesNotMatch(error.message, /execution-token|secret-value/);
				return true;
			});
			assert.equal(context.requests.filter(request => request.method === 'POST' && !request.url.endsWith('/jwt/login')).length, 1);
			assert.equal(context.requests.length, 7);
		}
	} finally {
		global.setTimeout = originalSetTimeout;
	}
});

test('queue helper uses local hours and does not log in', async () => {
	const cases = [
		['2025-01-01T07:59:00', 'L1.7x24'],
		['2025-01-01T08:00:00', 'L1.AVERIAS_GP'],
		['2025-01-01T18:59:00', 'L1.AVERIAS_GP'],
		['2025-01-01T19:00:00', 'L1.7x24'],
	];
	for (const [dateTime, assignedGroup] of cases) {
		const { context, promise } = run({ resource: 'helper', operation: 'getQueueForTime', dateTime });
		const [outputs] = await promise;
		assert.deepEqual(outputs[0].json, { assignedGroup, assignedSupportOrganization: 'GESTION PERSONALIZADA' });
		assert.equal(context.requests.length, 0);
	}
	const invalid = run({ resource: 'helper', operation: 'getQueueForTime', dateTime: 'invalid-date' });
	await assert.rejects(invalid.promise, /valid date/i);
	assert.equal(invalid.context.requests.length, 0);
});

test('query limits and offsets are validated before network requests', async () => {
	for (const params of [
		{ resource: 'site', operation: 'getMany', limit: -1 },
		{ resource: 'site', operation: 'getMany', limit: 1.5 },
		{ resource: 'site', operation: 'getMany', limit: Number.MAX_SAFE_INTEGER + 1 },
		{ resource: 'site', operation: 'getMany', offset: -1 },
		{ resource: 'site', operation: 'getMany', offset: Number.MAX_SAFE_INTEGER + 1 },
	]) {
		const { context, promise } = run(params);
		await assert.rejects(promise);
		assert.equal(context.requests.length, 0);
	}
});
test('update operations preserve endpoint entry identifiers across all writable forms', async () => {
	const cases = [
		['incident', 'HPD:IncidentInterface'],
		['company', 'COM:Company'],
		['workOrder', 'WOI:WorkOrderInterface'],
		['task', 'TMS:Task'],
		['changeRequest', 'CHG:ChangeInterface'],
		['workLog', 'HPD:WorkLog'],
	];
	const inputs = cases.map(() => ({}));
	const params = cases.map(([resource]) => ({
		resource, operation: 'update', entryId: 'ENTRY/α', fieldsJson: { Custom_Key: false },
	}));
	const { context, promise } = run(params, [login(), ...cases.map(() => response('', 204))], { inputs });
	const [outputs] = await promise;
	assert.equal(outputs.length, cases.length);
	for (let index = 0; index < cases.length; index++) {
		const [, form] = cases[index];
		assert.equal(context.requests[index + 1].method, 'PUT');
		assert.equal(context.requests[index + 1].url,
			`https://remedy.example.test/api/arsys/v1/entry/${encodeURIComponent(form)}/ENTRY%2F%CE%B1`);
		assert.deepEqual(context.requests[index + 1].body, { values: { Custom_Key: false } });
		assert.equal(outputs[index].json.entryId, 'ENTRY/α');
	}
});

test('singular business lookups use their exact fields and emit no item when absent', async () => {
	const cases = [
		['incident', 'HPD:IncidentInterface', 'incidentNumber', 'Incident Number', 'INC-1'],
		['company', 'COM:Company', 'companyEntryId', 'Company Entry ID', 'COMP-1'],
		['company', 'COM:Company', 'companyName', 'Company', 'Customer A', 'getByName'],
		['workOrder', 'WOI:WorkOrderInterface', 'workOrderId', 'Work Order ID', 'WO-1'],
		['task', 'TMS:Task', 'taskId', 'Task ID', 'TASK-1'],
		['changeRequest', 'CHG:ChangeInterface', 'infrastructureChangeId', 'Infrastructure Change ID', 'CR-1'],
		['workLog', 'HPD:WorkLog', 'workLogId', 'Work Log ID', 'WL-1'],
		['workInfo', 'WOI:WorkInfo', 'workOrderId', 'Work Order ID', 'WO-2'],
	];
	const inputs = cases.map(() => ({}));
	const params = cases.map(([resource, , parameterName, , value, operation]) => ({
		resource,
		operation: operation ?? 'get',
		[parameterName]: value,
	}));
	const { context, promise } = run(params, [login(), ...cases.map(() => response(list()))], { inputs });
	const [outputs] = await promise;
	assert.deepEqual(outputs, []);
	for (let index = 0; index < cases.length; index++) {
		const [, form, , field, value] = cases[index];
		const request = context.requests[index + 1];
		assert.equal(request.url, `https://remedy.example.test/api/arsys/v1/entry/${encodeURIComponent(form)}`);
		assert.equal(request.qs.q, `'${field}' == \"${value}\"`);
		assert.equal(request.qs.limit, 1);
	}
});

test('status selectors expose the exact supported values for each form', () => {
	const expected = {
		incident: ['Assigned', 'In Progress', 'Closed', 'Cancelled', 'Pending', 'Resolved'],
		workOrder: ['New', 'Assigned', 'In Progress', 'Pending', 'Resolved', 'Closed', 'Cancelled', 'Completed', 'Planning', 'Rejected', 'Waiting Approval'],
		task: ['Staged', 'Assigned', 'Pending', 'Work In Progress', 'Waiting', 'Closed', 'Bypassed'],
		changeRequest: ['Draft', 'Request For Authorization', 'Request For Change', 'Planning In Progress', 'Scheduled For Review', 'Scheduled For Approval', 'Scheduled', 'Implementation In Progress', 'Pending', 'Rejected', 'Completed', 'Closed', 'Cancelled'],
		company: ['Enabled', 'Disabled'],
		workLog: ['Proposed', 'Enabled', 'Offline', 'Obsolete', 'Archive', 'Delete'],
	};
	const properties = new Remedy().description.properties;
	for (const [resource, statuses] of Object.entries(expected)) {
		const property = properties.find(candidate => candidate.name === 'status' &&
			candidate.displayOptions.show.resource.includes(resource));
		assert.ok(property, `missing status property for ${resource}`);
		assert.deepEqual(property.options.map(option => option.value), statuses);
	}
});

test('incident assigned and in-progress operations use fixed status filters and source projection', async () => {
	const inputs = [{}, {}];
	const params = [
		{ resource: 'incident', operation: 'getAssigned', assignedGroup: 'L1' },
		{ resource: 'incident', operation: 'getInProgress', assignedGroup: 'L1' },
	];
	const { context, promise } = run(params, [login(), response(list()), response(list())], { inputs });
	await promise;
	assert.equal(context.requests[1].qs.q, `'Assigned Group' == "L1" AND 'Status' == "Assigned"`);
	assert.equal(context.requests[2].qs.q, `'Assigned Group' == "L1" AND 'Status' == "In Progress"`);
	assert.equal(context.requests[1].qs.fields,
		'values(Description,Detailed Decription,Incident Number,Request ID,Impact,Status,Status_Reason,Resolution,Assignee,Submit Date,Vendor Incidencia Number,Site)');
	assert.equal(context.requests[2].qs.fields, context.requests[1].qs.fields);
});
test('fixed incident queries ignore hidden qualification and fields but retain visible filters and paging', async () => {
	const { context, promise } = run({
		resource: 'incident',
		operation: 'getAssigned',
		assignedGroup: 'L1',
		qualification: "'Status' == \"stale\"",
		filters: { filter: [{ field: 'Priority', operator: '==', value: '2-High' }] },
		fields: 'Hidden Field',
		limit: 2,
		offset: 3,
	}, [login(), response(list())]);
	await promise;
	assert.equal(context.requests[1].qs.q,
		`'Assigned Group' == "L1" AND 'Status' == "Assigned" AND 'Priority' == "2-High"`);
	assert.equal(context.requests[1].qs.fields,
		'values(Description,Detailed Decription,Incident Number,Request ID,Impact,Status,Status_Reason,Resolution,Assignee,Submit Date,Vendor Incidencia Number,Site)');
	assert.equal(context.requests[1].qs.limit, 2);
	assert.equal(context.requests[1].qs.offset, 3);
});

test('upload target identifiers are required before binary data is read', async () => {
	const bytes = Buffer.from('payload');
	for (const params of [
		{ resource: 'incident', operation: 'uploadAttachment', comment: 'note', binaryPropertyName: 'data' },
		{ resource: 'workOrder', operation: 'uploadAttachment', comment: 'note', binaryPropertyName: 'data' },
	]) {
		const { context, promise } = run(params, [], {
			inputs: [{ binary: { data: { buffer: bytes, fileName: 'file.txt' } } }],
		});
		await assert.rejects(promise, /required/i);
		assert.equal(context.binaryBufferReads, 0);
		assert.equal(context.requests.length, 0);
	}
});

test('fragment and cutoff inputs reject unusable values before HTTP', async () => {
	const invalidFragments = [
		[[], 'Description Fragments must be a non-empty array of non-blank strings.'],
		[['  '], 'Description Fragments must be a non-empty array of non-blank strings.'],
		['{}', 'Description Fragments must be a non-empty array of non-blank strings.'],
		['[bad', 'Description Fragments JSON must be a valid JSON array.'],
	];
	for (const [descriptionFragments, message] of invalidFragments) {
		const { context, promise } = run({
			resource: 'helper', operation: 'findOpenIncidentsByFragments', descriptionFragments,
			assignedGroup: 'L1', assignedSupportOrganization: 'OPS',
		});
		await assert.rejects(promise, error => error.message === message);
		assert.equal(context.requests.length, 0);
	}
	for (const operation of ['findOpenIncidentsByFragments', 'findOpenIncidentByDescription']) {
		const { context, promise } = run({
			resource: 'helper', operation,
			descriptionFragments: ['ALERT'], description: 'ALERT', sinceDays: 200000000,
			assignedGroup: 'L1', assignedSupportOrganization: 'OPS',
		});
		await assert.rejects(promise, /Since Days produces an out-of-range date/i);
		assert.equal(context.requests.length, 0);
	}
});

test('fragment search preserves whitespace in nonblank literal fragments', async () => {
	const { context, promise } = run({
		resource: 'helper', operation: 'findOpenIncidentsByFragments',
		descriptionFragments: [' ALERT '], assignedGroup: 'L1', assignedSupportOrganization: 'OPS',
	}, [login(), response(list(
		entry({ Description: 'ALERT down', Status: 'Assigned' }),
		entry({ Description: 'prefix ALERT suffix', Status: 'Assigned' }),
	))]);
	const [outputs] = await promise;
	assert.deepEqual(outputs.map(item => item.json.values.Description), ['prefix ALERT suffix']);
	assert.equal(context.requests.length, 2);
});

test('WorkInfo additional JSON cannot override typed comment fields', async () => {
	const { context, promise } = run({
		resource: 'workInfo', operation: 'create', workOrderId: 'WO-1', detailedDescription: 'note',
		fieldsJson: { 'Work Order ID': 'WO-2' },
	});
	await assert.rejects(promise, /cannot override explicit WorkInfo field/i);
	assert.equal(context.requests.length, 0);
});

test('attachment metadata with malformed non-null slots is an API error', async () => {
	const { context, promise } = run({ resource: 'attachment', operation: 'getMany', incidentNumber: 'INC-1' }, [
		login(),
		response(list(entry({ 'z2AF Work Log01': { name: 'file', href: '/api/file' }, 'z2AF Work Log02': 'broken' }))),
		response(list()),
	]);
	await assert.rejects(promise, /malformed attachment metadata/i);
	assert.equal(context.requests.length, 3);
});

test('missing upload binary fails before login or HTTP', async () => {
	const { context, promise } = run({
		resource: 'incident', operation: 'uploadAttachment', entryId: 'REQ-1', comment: 'note',
		binaryPropertyName: 'missing',
	});
	await assert.rejects(promise, /binary property.*missing/i);
	assert.equal(context.requests.length, 0);
});
test('RemedyClient paging advances by actual result counts and requests a terminal empty page', async () => {
	const first = entry({ ID: 'A' });
	const second = entry({ ID: 'B' });
	const third = entry({ ID: 'C' });
	const context = createContext({
		responses: [login(), response(list(first, second)), response(list(third)), response(list())],
	});
	const client = new RemedyClient(context, CREDENTIALS);
	const query = { q: "'Status' == \"Open\"", fields: 'values(ID)', limit: 9, offset: 99 };
	const entries = [];
	for await (const page of client.getPages('Example', query, { pageSize: 100, maxPages: 4, offset: 7 })) {
		for (const item of page) entries.push(item);
	}
	assert.deepEqual(entries.map(item => item.values.ID), ['A', 'B', 'C']);
	assert.deepEqual(context.requests.slice(1).map(request => request.qs), [
		{ q: query.q, fields: query.fields, limit: 100, offset: 7 },
		{ q: query.q, fields: query.fields, limit: 100, offset: 9 },
		{ q: query.q, fields: query.fields, limit: 100, offset: 10 },
	]);
	assert.equal(query.limit, 9);
	assert.equal(query.offset, 99);
	assert.equal(context.requests.length, 4);
});

test('RemedyClient paging validates bounds before login and accepts an empty first page', async () => {
	const invalidOptions = [
		[{ pageSize: 0, maxPages: 2 }, /Page Size/],
		[{ pageSize: 1, maxPages: 0 }, /Max Pages/],
		[{ pageSize: 1, maxPages: 1, offset: -1 }, /Offset/],
		[{ pageSize: 1, maxPages: 1, offset: null }, /Offset/],
		[{ pageSize: 1.5, maxPages: 1 }, /Page Size/],
		[{ pageSize: 1, maxPages: Number.MAX_SAFE_INTEGER + 1 }, /Max Pages/],
	];
	for (const [options, message] of invalidOptions) {
		const context = createContext();
		const client = new RemedyClient(context, CREDENTIALS);
		await assert.rejects(async () => {
			for await (const _page of client.getPages('Example', {}, options)) { /* no pages expected */ }
		}, message);
		assert.equal(context.requests.length, 0);
	}

	const empty = createContext({ responses: [login(), response(list())] });
	const client = new RemedyClient(empty, CREDENTIALS);
	const pages = [];
	for await (const page of client.getPages('Example', {}, { pageSize: 5, maxPages: 1 })) pages.push(page);
	assert.deepEqual(pages, []);
	assert.equal(empty.requests.length, 2);
	assert.equal(empty.requests[1].qs.offset, 0);
});

test('RemedyClient paging fails incomplete, overflowed, and unauthorized reads safely', async () => {
	const repeated = entry({ ID: 'same' });
	const capped = createContext({
		responses: [login(), response(list(repeated)), response(list(repeated))],
	});
	const cappedClient = new RemedyClient(capped, CREDENTIALS);
	const received = [];
	await assert.rejects(async () => {
		for await (const page of cappedClient.getPages('Example', {}, { pageSize: 10, maxPages: 2 })) {
			for (const item of page) received.push(item);
		}
	}, error => error.message === 'Remedy pagination reached Max Pages before an empty page; results are incomplete.');
	assert.equal(received.length, 2);
	assert.equal(capped.requests.length, 3);

	const overflow = createContext({ responses: [login(), response(list(entry({ ID: 'last' })))] });
	const overflowClient = new RemedyClient(overflow, CREDENTIALS);
	const overflowPages = [];
	await assert.rejects(async () => {
		for await (const page of overflowClient.getPages('Example', {}, {
			pageSize: 1, maxPages: 2, offset: Number.MAX_SAFE_INTEGER,
		})) overflowPages.push(page);
	}, /offset exceeded the safe integer range/i);
	assert.deepEqual(overflowPages, []);
	assert.equal(overflow.requests.length, 2);

	const unauthorized = createContext({ responses: [login(), response(list(repeated)), response({ message: 'denied' }, 401)] });
	const unauthorizedClient = new RemedyClient(unauthorized, CREDENTIALS);
	const successfulPages = [];
	await assert.rejects(async () => {
		for await (const page of unauthorizedClient.getPages('Example', {}, { pageSize: 1, maxPages: 5 })) {
			successfulPages.push(page);
		}
	}, /HTTP 401/);
	assert.equal(successfulPages.length, 1);
	assert.equal(unauthorized.requests.length, 3);
});

test('shared paging parser ignores stale hidden values and supplies validated defaults', () => {
	const hidden = createContext({ params: { returnAll: false, pageSize: 0, maxPages: 'invalid' } });
	assert.equal(readPagingOptions(hidden, 0), undefined);
	assert.deepEqual(readPagingOptions(createContext({ params: { returnAll: true } }), 0), {
		pageSize: 100, maxPages: 100,
	});
	assert.throws(() => readPagingOptions(createContext({
		params: { returnAll: true, pageSize: 0, maxPages: 2 },
	}), 0), /Page Size/);
});
test('ordinary Return All preserves starting offset and ignores a hidden Limit', async () => {
	const { context, promise } = run({
		resource: 'site', operation: 'getMany', returnAll: true,
		pageSize: 100, maxPages: 4, limit: 'invalid-hidden-limit', offset: 7,
	}, [
		login(),
		response(list(entry({ 'Site ID': 'S1' }), entry({ 'Site ID': 'S2' }))),
		response(list(entry({ 'Site ID': 'S3' }))),
		response(list()),
	]);
	const [outputs] = await promise;
	assert.deepEqual(outputs.map(item => item.json.values['Site ID']), ['S1', 'S2', 'S3']);
	assert.deepEqual(outputs.map(item => item.pairedItem), [{ item: 0 }, { item: 0 }, { item: 0 }]);
	assert.deepEqual(context.requests.slice(1).map(request => request.qs), [
		{ limit: 100, offset: 7 },
		{ limit: 100, offset: 9 },
		{ limit: 100, offset: 10 },
	]);
	assert.equal(context.requests.filter(request => request.url.endsWith('/jwt/login')).length, 1);
});

test('fixed incident Return All keeps fixed projection, visible filters, and starting offset', async () => {
	const { context, promise } = run({
		resource: 'incident', operation: 'getInProgress', assignedGroup: 'L1',
		returnAll: true, pageSize: 1, maxPages: 3, limit: -1, offset: 3,
		qualification: "'Status' == \"stale\"",
		filters: { filter: [{ field: 'Priority', operator: '==', value: '2-High' }] },
		fields: 'Hidden Field',
	}, [login(), response(list(entry({ 'Incident Number': 'INC-1' }))), response(list())]);
	await promise;
	assert.equal(context.requests[1].qs.q,
		`'Assigned Group' == "L1" AND 'Status' == "In Progress" AND 'Priority' == "2-High"`);
	assert.equal(context.requests[1].qs.fields,
		'values(Description,Detailed Decription,Incident Number,Request ID,Impact,Status,Status_Reason,Resolution,Assignee,Submit Date,Vendor Incidencia Number,Site)');
	assert.deepEqual(context.requests.slice(1).map(request => [request.qs.limit, request.qs.offset]), [[1, 3], [1, 4]]);
});

test('work order comments paginate with only their mandatory business-ID filter and list controls', async () => {
	const { context, promise } = run({
		resource: 'workOrder', operation: 'getComments', workOrderId: 'WO-1',
		returnAll: true, pageSize: 2, maxPages: 3, offset: 4, limit: 'hidden-invalid',
		qualification: "'Work Order ID' == \"wrong\"",
		filters: { filter: [{ field: 'Status', operator: '==', value: 'wrong' }] },
		fields: 'Hidden Field',
	}, [login(), response(list(entry({ Text: 'one' }))), response(list())]);
	const [outputs] = await promise;
	assert.deepEqual(outputs.map(item => item.json.values.Text), ['one']);
	assert.deepEqual(context.requests.slice(1).map(request => request.qs), [
		{ q: "'Work Order ID' == \"WO-1\"", limit: 2, offset: 4 },
		{ q: "'Work Order ID' == \"WO-1\"", limit: 2, offset: 5 },
	]);
});

test('attachment Return All pages both sources independently and preserves source order', async () => {
	const worklogFile = entry({
		'z2AF Work Log01': { name: 'worklog.txt', href: '/worklog', sizeBytes: 1 },
		'Work Log ID': 'WL-2',
	});
	const cfgFile = entry({
		'z2AF Work Log01': { name: 'incident.eml', href: '/incident', sizeBytes: 2 },
		'CFG Attachment ID': 'CFG-2',
	});
	const { context, promise } = run({
		resource: 'attachment', operation: 'getMany', incidentNumber: 'INC-1',
		returnAll: true, pageSize: 1, maxPages: 4,
	}, [
		login(),
		response(list(entry({}))), response(list(worklogFile)), response(list()),
		response(list(entry({}))), response(list(cfgFile)), response(list()),
	]);
	const [outputs] = await promise;
	assert.deepEqual(outputs.map(item => item.json), [
		{ name: 'worklog.txt', url: '/worklog', sizeBytes: 1, type: 'worklog', workLogId: 'WL-2' },
		{ name: 'incident.eml', url: '/incident', sizeBytes: 2, type: 'incident', attachmentId: 'CFG-2' },
	]);
	assert.deepEqual(context.requests.slice(1).map(request => request.qs.offset), [0, 1, 2, 0, 1, 2]);
	assert.equal(context.requests[1].qs.fields, 'values(z2AF Work Log01,z2AF Work Log02,z2AF Work Log03,Work Log ID)');
	assert.equal(Object.hasOwn(context.requests[4].qs, 'fields'), false);
});

test('late attachment pagination failure emits one error and keeps the next input paired', async () => {
	const inputs = [{}, {}];
	const params = [
		{ resource: 'attachment', operation: 'getMany', incidentNumber: 'INC-1', returnAll: true, pageSize: 1, maxPages: 3 },
		{ resource: 'site', operation: 'getMany', returnAll: true, pageSize: 1, maxPages: 3 },
	];
	const worklogFile = entry({ 'z2AF Work Log01': { name: 'partial.txt', href: '/partial' } });
	const cfgFile = entry({ 'z2AF Work Log01': { name: 'also-partial.txt', href: '/also-partial' } });
	const { context, promise } = run(params, [
		login(),
		response(list(worklogFile)), response(list()),
		response(list(cfgFile)), response({ message: 'CFG page failed' }, 503),
		response(list(entry({ 'Site ID': 'S2' }))), response(list()),
	], { inputs, continueOnFail: true });
	const [outputs] = await promise;
	assert.equal(outputs.length, 2);
	assert.match(outputs[0].json.error, /HTTP 503/);
	assert.deepEqual(outputs[0].pairedItem, { item: 0 });
	assert.equal(outputs[1].json.values['Site ID'], 'S2');
	assert.deepEqual(outputs[1].pairedItem, { item: 1 });
	assert.equal(outputs.some(item => item.json.name === 'partial.txt' || item.json.name === 'also-partial.txt'), false);
	assert.equal(context.requests.length, 7);
});

test('fragment helper finds page-two matches and exact search stops at its first open page match', async () => {
	const fragment = run({
		resource: 'helper', operation: 'findOpenIncidentsByFragments',
		descriptionFragments: ['ALERT'], assignedGroup: 'L1', assignedSupportOrganization: 'OPS',
		returnAll: true, pageSize: 1, maxPages: 4,
	}, [
		login(),
		response(list(entry({ Description: 'unrelated', Status: 'Assigned' }))),
		response(list(entry({ Description: 'ALERT on page two', Status: 'In Progress' }))),
		response(list()),
	]);
	const [fragmentOutputs] = await fragment.promise;
	assert.deepEqual(fragmentOutputs.map(item => item.json.values.Description), ['ALERT on page two']);
	assert.deepEqual(fragment.context.requests.slice(1).map(request => request.qs.offset), [0, 1, 2]);

	const exact = run({
		resource: 'helper', operation: 'findOpenIncidentByDescription',
		description: 'same alert', returnAll: true, pageSize: 1, maxPages: 5,
	}, [
		login(),
		response(list(entry({ Description: 'same alert', Status: 'Closed' }))),
		response(list(entry({ Description: 'same alert', Status: 'Assigned', marker: 'first-open' }))),
		response(list(entry({ Description: 'same alert', Status: 'In Progress', marker: 'later-open' }))),
	]);
	const [exactOutputs] = await exact.promise;
	assert.equal(exactOutputs[0].json.values.marker, 'first-open');
	assert.deepEqual(exact.context.requests.slice(1).map(request => request.qs.offset), [0, 1]);
	assert.equal(exact.context.requests.length, 3);
});

test('paging UI exposes controls only for supported operation modes', () => {
	const properties = new Remedy().description.properties;
	const property = name => properties.find(candidate => candidate.name === name);
	assert.equal(property('returnAll').default, false);
	assert.equal(property('pageSize').default, 100);
	assert.equal(property('pageSize').typeOptions.minValue, 1);
	assert.deepEqual(property('pageSize').displayOptions.show.returnAll, [true]);
	assert.equal(property('maxPages').default, 100);
	assert.equal(property('maxPages').typeOptions.minValue, 1);
	assert.deepEqual(property('maxPages').displayOptions.show.returnAll, [true]);
	assert.deepEqual(property('qualification').displayOptions.show.operation, ['getMany']);
	assert.deepEqual(property('fields').displayOptions.show.operation, ['getMany']);
	assert.ok(property('filters').displayOptions.show.operation.includes('getAssigned'));
	assert.deepEqual(property('limit').displayOptions.show.returnAll, [false]);
	assert.equal(property('limit').default, 0);
	assert.equal(property('limit').typeOptions.minValue, 0);
	assert.equal(property('offset').displayOptions.show.returnAll, undefined);
	assert.ok(property('returnAll').displayOptions.show.resource.includes('attachment'));
	assert.deepEqual(property('descriptionFragments').default, '[]');
	assert.equal(property('timeZone').default, '');
});
test('ordinary Return All cap failure does not return accumulated entries', async () => {
	const { context, promise } = run({
		resource: 'site', operation: 'getMany', returnAll: true, pageSize: 1, maxPages: 2,
	}, [
		login(),
		response(list(entry({ 'Site ID': 'S1' }))),
		response(list(entry({ 'Site ID': 'S2' }))),
	], { continueOnFail: true });
	const [outputs] = await promise;
	assert.equal(outputs.length, 1);
	assert.match(outputs[0].json.error, /Remedy pagination reached Max Pages before an empty page; results are incomplete/);
	assert.deepEqual(outputs[0].pairedItem, { item: 0 });
	assert.equal(context.requests.length, 3);
});
test('Extract Entry ID validates Remedy links and feeds the decoded ID to updates', async () => {
	const absoluteUrl = 'https://remedy.example.test/api/arsys/v1/entry/HPD%3AIncidentInterface/REQ%2F%E9%9B%AA%20A';
	const extracted = run({ resource: 'helper', operation: 'extractEntryId', entryUrl: absoluteUrl });
	const [outputs] = await extracted.promise;
	assert.deepEqual(outputs[0].json, {
		entryId: 'REQ/雪 A',
		form: 'HPD:IncidentInterface',
		url: absoluteUrl,
	});
	assert.deepEqual(outputs[0].pairedItem, { item: 0 });
	assert.equal(extracted.context.requests.length, 0);

	const relativeUrl = '/api/arsys/v1/entry/EVO%3AEVO_Server/server%2F%CE%B1%20one';
	const relative = run({ resource: 'helper', operation: 'extractEntryId', entryUrl: relativeUrl });
	const [relativeOutputs] = await relative.promise;
	assert.deepEqual(relativeOutputs[0].json, {
		entryId: 'server/α one',
		form: 'EVO:EVO_Server',
		url: `https://remedy.example.test${relativeUrl}`,
	});
	assert.equal(relative.context.requests.length, 0);

	const updated = run({
		resource: 'incident', operation: 'update', entryId: outputs[0].json.entryId, fieldsJson: { Status: 'Pending' },
	}, [login(), response('', 204)]);
	await updated.promise;
	assert.equal(updated.context.requests[1].url,
		'https://remedy.example.test/api/arsys/v1/entry/HPD%3AIncidentInterface/REQ%2F%E9%9B%AA%20A');

	const helperOperation = new Remedy().description.properties.find(property => property.name === 'operation' &&
		property.displayOptions.show.resource.includes('helper'));
	assert.ok(helperOperation.options.some(option => option.value === 'extractEntryId' && option.name === 'Extract Entry ID'));
});

test('Extract Entry ID rejects malformed and out-of-scope URLs without HTTP', async () => {
	const invalid = [
		['', /Entry URL is required/],
		['https://foreign.example/api/arsys/v1/entry/F/ID', /configured Remedy origin/i],
		['https://remedy.example.test/other/arsys/v1/entry/F/ID', /configured Remedy API root/i],
		['https://remedy.example.test/api/arsys/v1/entry/F/ID?include=values', /query string or fragment/i],
		['https://remedy.example.test/api/arsys/v1/entry/F/ID#part', /query string or fragment/i],
		['/api/arsys/v1/entry/F/', /exactly one form and one entry ID/i],
		['/api/arsys/v1/entry/F', /exactly one form and one entry ID/i],
		['/api/arsys/v1/entry/F/bad%ZZ', /malformed percent-encoding/i],
		['/api/attachments/file', /Remedy entry endpoint/i],
		['https://user@remedy.example.test/api/arsys/v1/entry/F/ID', /embedded credentials/i],
	];
	for (const [entryUrl, message] of invalid) {
		const { context, promise } = run({ resource: 'helper', operation: 'extractEntryId', entryUrl });
		await assert.rejects(promise, message);
		assert.equal(context.requests.length, 0);
	}
});
test('queue helper routes against explicit IANA zones, seasonal offsets, boundaries, and DST', async () => {
	const cases = [
		['2025-01-01T06:59:00Z', 'L1.7x24'],
		['2025-01-01T07:00:00Z', 'L1.AVERIAS_GP'],
		['2025-01-01T17:59:00Z', 'L1.AVERIAS_GP'],
		['2025-01-01T18:00:00Z', 'L1.7x24'],
		['2025-01-01T07:00:00Z', 'L1.AVERIAS_GP'],
		['2025-07-01T06:00:00Z', 'L1.AVERIAS_GP'],
		['2025-01-01T07:00:00+0000', 'L1.AVERIAS_GP'],
		['2025-03-30T05:59:00Z', 'L1.7x24'],
		['2025-03-30T06:00:00Z', 'L1.AVERIAS_GP'],
	];
	for (const [dateTime, assignedGroup] of cases) {
		const { context, promise } = run({
			resource: 'helper', operation: 'getQueueForTime', dateTime, timeZone: 'Europe/Madrid',
		});
		const [outputs] = await promise;
		assert.equal(outputs[0].json.assignedGroup, assignedGroup, dateTime);
		assert.equal(outputs[0].json.assignedSupportOrganization, 'GESTION PERSONALIZADA');
		assert.equal(context.requests.length, 0);
	}
	const zoneField = new Remedy().description.properties.find(property => property.name === 'timeZone');
	assert.equal(zoneField.default, '');
});

test('queue helper rejects invalid zones and offset-less zoned dates locally', async () => {
	const invalidZone = run({
		resource: 'helper', operation: 'getQueueForTime',
		dateTime: '2025-01-01T07:00:00Z', timeZone: 'Not/A_Zone',
	});
	await assert.rejects(invalidZone.promise, error => error.message === 'Time Zone must be a valid IANA time zone.');
	assert.equal(invalidZone.context.requests.length, 0);

	const ambiguous = run({
		resource: 'helper', operation: 'getQueueForTime',
		dateTime: '2025-01-01T07:00:00', timeZone: 'Europe/Madrid',
	});
	await assert.rejects(ambiguous.promise,
		error => error.message === 'Date Time must include Z or a numeric offset when Time Zone is set.');
	assert.equal(ambiguous.context.requests.length, 0);
});

'use strict';

const NODE = {
	id: 'remedy-test-node',
	name: 'Remedy',
	type: 'remedy',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const CREDENTIALS = {
	baseUrl: 'https://remedy.example.test/api',
	username: 'automation user',
	password: 'secret-value',
	allowUnauthorizedCerts: false,
};

function createContext({ params = {}, inputs = [{}], responses = [], credentials = CREDENTIALS, continueOnFail = false } = {}) {
	const requests = [];
	const queue = [...responses];
	let credentialsReads = 0;
	let binaryBufferReads = 0;
	const context = {
		requests,
		credentials,
		get credentialsReads() { return credentialsReads; },
		get binaryBufferReads() { return binaryBufferReads; },
		getNode: () => NODE,
		getInputData: () => inputs,
		getCredentials: async () => {
			credentialsReads++;
			return credentials;
		},
		getNodeParameter(name, itemIndex, fallback) {
			const itemParameters = Array.isArray(params) ? params[itemIndex] : params;
			if (itemParameters && Object.prototype.hasOwnProperty.call(itemParameters, name)) return itemParameters[name];
			return fallback;
		},
		continueOnFail: () => continueOnFail,
		helpers: {
			async httpRequest(options) {
				requests.push(options);
				if (queue.length === 0) throw new Error(`Unexpected request ${options.method} ${options.url}`);
				const next = queue.shift();
				if (typeof next === 'function') return await next(options, requests.length - 1);
				if (next instanceof Error) throw next;
				return next;
			},
			async getBinaryDataBuffer(itemIndex, property) {
				binaryBufferReads++;
				const binary = inputs[itemIndex]?.binary?.[property];
				if (!binary) throw new Error(`Missing binary ${property}`);
				if (Buffer.isBuffer(binary.buffer)) return binary.buffer;
				if (typeof binary.data === 'string') return Buffer.from(binary.data, 'base64');
				throw new Error(`Invalid binary ${property}`);
			},
			async prepareBinaryData(buffer, fileName, mimeType) {
				return {
					data: Buffer.from(buffer).toString('base64'),
					fileName,
					mimeType,
					fileSize: String(buffer.length),
				};
			},
		},
	};
	return context;
}

function response(body, statusCode = 200, headers = {}) {
	return { body, statusCode, headers };
}

function login(token = 'jwt-token') {
	return response(token, 200);
}

module.exports = { CREDENTIALS, NODE, createContext, login, response };

import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { executeOperation } from '../../execute/executeOperation';
import { RemedyClient, RemedyHttpError, remedyApiTest, type RemedyCredentials } from '../../transport/RemedyClient';
import { buildProperties } from './ui/buildProperties';

export class Remedy implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Remedy',
		name: 'remedy',
		icon: 'file:remedy.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Interact with BMC Remedy ITSM records and Remedy-only helper workflows',
		defaults: { name: 'Remedy' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'remedyApi', required: true, testedBy: 'remedyApiTest' }],
		properties: buildProperties(),
	};

	methods = {
		credentialTest: {
			remedyApiTest: remedyApiTest,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const credentials = (await this.getCredentials('remedyApi')) as unknown as RemedyCredentials;
		const client = new RemedyClient(this, credentials);
		const outputItems: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const results = await executeOperation(this, client, itemIndex, inputItems[itemIndex], resource, operation);
				for (const result of results) {
					outputItems.push({
						json: result.json,
						...(result.binary === undefined ? {} : { binary: result.binary }),
						pairedItem: { item: itemIndex },
					});
				}
			} catch (caught) {
				const error = caught instanceof Error ? caught : new Error(String(caught));
				if (this.continueOnFail()) {
					outputItems.push({ json: { error: error.message }, pairedItem: { item: itemIndex } });
					continue;
				}
				if (error instanceof NodeApiError || error instanceof NodeOperationError) throw error;
				if (error instanceof RemedyHttpError) {
					throw new NodeApiError(this.getNode(), {
						message: error.message,
						...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
					}, {
						message: error.message,
						...(error.statusCode === undefined ? {} : { httpCode: String(error.statusCode) }),
						itemIndex,
					});
				}
				throw new NodeOperationError(this.getNode(), error.message, { itemIndex });
			}
		}
		return [outputItems];
	}
}

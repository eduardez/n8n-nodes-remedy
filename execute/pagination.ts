import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { RemedyPagingOptions } from '../transport/RemedyClient';

export function readPagingOptions(context: IExecuteFunctions, itemIndex: number): RemedyPagingOptions | undefined {
	const returnAll = context.getNodeParameter('returnAll', itemIndex, false);
	if (returnAll === false) return undefined;
	if (returnAll !== true) {
		throw new NodeOperationError(context.getNode(), 'Return All must be a boolean.', { itemIndex });
	}
	const pageSize = Number(context.getNodeParameter('pageSize', itemIndex, 100));
	if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
		throw new NodeOperationError(context.getNode(), 'Page Size must be a positive safe integer.', { itemIndex });
	}
	const maxPages = Number(context.getNodeParameter('maxPages', itemIndex, 100));
	if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
		throw new NodeOperationError(context.getNode(), 'Max Pages must be a positive safe integer.', { itemIndex });
	}
	return { pageSize, maxPages };
}

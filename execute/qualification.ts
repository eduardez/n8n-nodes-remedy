const QUALIFICATION_OPERATORS: Record<string, true> = {
	'==': true,
	'!=': true,
	'>': true,
	'>=': true,
	'<': true,
	'<=': true,
	LIKE: true,
};

function escapeField(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function qualificationFilter(field: string, operator: string, value: string): string {
	if (QUALIFICATION_OPERATORS[operator] !== true) {
		throw new Error(`Unsupported Remedy filter operator "${operator}".`);
	}
	return `'${escapeField(field)}' ${operator} "${escapeValue(value)}"`;
}

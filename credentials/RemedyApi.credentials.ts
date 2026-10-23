import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class RemedyApi implements ICredentialType {
	name = 'remedyApi';

	displayName = 'Remedy API';
	icon: Icon = 'file:bmc-logo.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://remedy.example.com/api',
			description: 'Remedy API base URL. A trailing slash is ignored; /api is not added automatically.',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Allow Unauthorized Certificates',
			name: 'allowUnauthorizedCerts',
			type: 'boolean',
			default: false,
			description: 'Skip TLS certificate validation only for trusted self-signed Remedy instances.',
		},
	];
}

import {
	Callback,
	Context,
	UserMigrationAuthenticationTriggerEvent,
	UserMigrationTriggerEvent
} from 'aws-lambda';
import { CognitoIdentityServiceProvider, ChainableTemporaryCredentials } from 'aws-sdk';
import { AdminInitiateAuthRequest } from 'aws-sdk/clients/cognitoidentityserviceprovider';

/**
 * AWS region in which your User Pools are deployed
 */
const OLD_USER_POOL_REGION = process.env.OLD_USER_POOL_REGION || process.env.AWS_REGION;

/**
 * ID of the old User Pool from which you want to migrate users
 */
const OLD_USER_POOL_ID: string = process.env.OLD_USER_POOL_ID || '<OLD_USER_POOL_ID>';

/**
 * Client ID in the old User Pool from which you want to migrate users.
 */
const OLD_CLIENT_ID: string = process.env.OLD_CLIENT_ID || '<OLD_CLIENT_ID>';

const OLD_ROLE_ARN: string | undefined = process.env.OLD_ROLE_ARN;
const OLD_EXTERNAL_ID: string | undefined = process.env.OLD_EXTERNAL_ID;

interface User {
	userAttributes: {[key: string]: string | undefined};
	userName: string;
}

async function authenticateUser(cognitoISP: CognitoIdentityServiceProvider, username: string, password: string): Promise<User | undefined> {
	console.log(`authenticateUser: user='${username}'`);

	try {
		const params: AdminInitiateAuthRequest = {
			AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
			AuthParameters: {
				PASSWORD: password,
				USERNAME: username,
			},
			ClientId: OLD_CLIENT_ID,
			UserPoolId: OLD_USER_POOL_ID,
		};
		const cognitoResponse = await cognitoISP.adminInitiateAuth(params).promise();
		console.log(`authenticateUser: found ${JSON.stringify(cognitoResponse)}`);
		return lookupUser(cognitoISP, username);
	} catch (err) {
		console.log(`authenticateUser: error ${JSON.stringify(err)}`);
		return undefined;
	}
}

async function lookupUser(cognitoISP: CognitoIdentityServiceProvider, username: string): Promise<User | undefined> {
	console.log(`lookupUser: user='${username}'`);

	try {
		const params = {
			UserPoolId: OLD_USER_POOL_ID,
			Username: username,
		};
		const cognitoResponse = await cognitoISP.adminGetUser(params).promise();
		console.log(`lookupUser: found ${JSON.stringify(cognitoResponse)}`);

		const userAttributes = cognitoResponse.UserAttributes ? cognitoResponse.UserAttributes.reduce((acc, entry) => ({
			...acc,
			[entry.Name]: entry.Value,
		}), {} as {[key: string]: string | undefined}) : {};
		const user: User = {
			userAttributes,
			userName: cognitoResponse.Username,
		};
		console.log(`lookupUser: response ${JSON.stringify(user)}`);
		return user;
	} catch (err) {
		console.log(`lookupUser: error ${JSON.stringify(err)}`);
		return undefined;
	}
}

async function onUserMigrationAuthentication(cognitoISP: CognitoIdentityServiceProvider, event: UserMigrationAuthenticationTriggerEvent) {
	// authenticate the user with your existing user directory service
	const user = await authenticateUser(cognitoISP, event.userName!, event.request.password!);
	if (!user) {
		throw new Error('Bad credentials');
	}
	event.response.userAttributes = {
		...user.userAttributes,
		email: user.userAttributes.email!,
		preferred_username: user.userAttributes.preferred_username!,
		// @ts-ignore
		'custom:old_sub': user.userAttributes.sub,
	};
	delete event.response.userAttributes.sub;
	event.response.finalUserStatus = 'CONFIRMED';
	event.response.messageAction = 'SUPPRESS';

	console.log(`Authentication - response: ${JSON.stringify(event.response)}`);
	return event;
}

async function onUserMigrationForgotPassword(cognitoISP: CognitoIdentityServiceProvider, event: UserMigrationTriggerEvent) {
	// Lookup the user in your existing user directory service
	const user = await lookupUser(cognitoISP, event.userName!);
	if (!user) {
		throw new Error('Bad credentials');
	}

	event.response.userAttributes = {
		...user.userAttributes,
		email: user.userAttributes.email!,
		preferred_username: user.userAttributes.preferred_username!,
		// @ts-ignore
		'custom:old_sub': user.userAttributes.sub,
	};
	delete event.response.userAttributes.sub;
	event.response.messageAction = 'SUPPRESS';
	console.log(`Forgot password - response: ${JSON.stringify(event.response)}`);

	return event;
}

export const handler = async (event: UserMigrationTriggerEvent, context: Context, callback: Callback) => {
	console.log("Event: ",event)
	const options: CognitoIdentityServiceProvider.Types.ClientConfiguration = {
		region: OLD_USER_POOL_REGION,
	};
	if (OLD_ROLE_ARN) {
		options.credentials = new ChainableTemporaryCredentials({
			params: {
				ExternalId: OLD_EXTERNAL_ID,
				RoleArn: OLD_ROLE_ARN,
				RoleSessionName: context.awsRequestId,
			},
		});
	}
	const cognitoIdentityServiceProvider = new CognitoIdentityServiceProvider(options);

	switch (event.triggerSource) {
		case 'UserMigration_Authentication':
			try {
				const data = await onUserMigrationAuthentication(cognitoIdentityServiceProvider, event);
				callback(null, data);
			}catch (e) {
				callback(`Bad triggerSource ${event.triggerSource}`);
			}
		case 'UserMigration_ForgotPassword':
			try {
				const data = await onUserMigrationForgotPassword(cognitoIdentityServiceProvider, event);
				callback(null, data);
			}catch (e) {
				callback(`Bad triggerSource ${event.triggerSource}`);
			}
		default:
			callback(`Bad triggerSource ${event.triggerSource}`);
	}
}

#!/usr/bin/env npx tsx

import { ACCOUNT_FILE, doQrLogin, loadAccountFromEnv, loadSavedAccount, WECHAT_BASE_URL } from "./wechat-ilink-shared.js";

function log(message: string): void {
	console.log(`[wechat-setup] ${message}`);
}

function logError(message: string): void {
	console.error(`[wechat-setup] ${message}`);
}

async function main(): Promise<void> {
	const envAccount = loadAccountFromEnv();
	if (envAccount) {
		log("WECHAT_ILINK_TOKEN is already set in the environment.");
		log("No saved credential file is needed when running from env.");
		return;
	}

	const existing = loadSavedAccount();
	if (existing) {
		log(`Existing saved account: ${existing.accountId}`);
		log(`Credential file: ${ACCOUNT_FILE}`);
		log("A new QR login will overwrite the saved credential file.");
	}

	const account = await doQrLogin(WECHAT_BASE_URL);
	if (!account) {
		throw new Error("WeChat QR login failed.");
	}

	log(`Login successful for account ${account.accountId}`);
	log(`Saved credentials to ${ACCOUNT_FILE}`);
	log('Now run: npx tsx examples/wechat-ilink.ts');
}

main().catch((error) => {
	logError(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

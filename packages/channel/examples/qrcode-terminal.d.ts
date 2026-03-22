declare module "qrcode-terminal" {
	interface GenerateOptions {
		small?: boolean;
	}

	interface QRCodeTerminal {
		generate(text: string, callback: (qrcode: string) => void): void;
		generate(text: string, options: GenerateOptions, callback: (qrcode: string) => void): void;
	}

	const qrcodeTerminal: QRCodeTerminal;
	export default qrcodeTerminal;
}

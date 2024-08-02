export function toBase64(data: Record<string, any>): string {
    return Buffer.from(JSON.stringify(data)).toString('base64');
};

export function fromBase64(payload: string): Record<string, any> {
    return JSON.parse(Buffer.from(payload, 'base64').toString());
};

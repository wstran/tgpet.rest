import Decimal from 'decimal.js';

export function roundDown(value: number, decimals: number) {
  return new Decimal(value).toFixed(decimals, Decimal.ROUND_DOWN);
};

export function getRandomInt(min: number, max: number): number {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

export function generateRandomUpperString(length: number): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    return Array.from({ length }).reduce((prev: string) => prev + characters.charAt(Math.floor(Math.random() * characters.length)), '');
};
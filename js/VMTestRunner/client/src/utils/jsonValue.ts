/**
 * Преобразует строку из UI-инпута в JSON-значение (число, boolean, объект/массив или строку).
 */
export function parseDynamicValue(raw: string): unknown {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    if (!Number.isNaN(Number(trimmed))) return Number(trimmed);
    if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return raw;
        }
    }
    return raw;
}

export function formatDynamicValue(val: unknown): string {
    if (val === undefined) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
}

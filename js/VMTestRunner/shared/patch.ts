/**
 * Рекурсивно применяет частичный патч к целевому объекту.
 * Для вложенных массивов (например, Bus[0]) поддерживает патч по числовому ключу-индексу или замену массива.
 */
export function applyDeepPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
    for (const [key, val] of Object.entries(patch)) {
        const cur = target[key];
        if (val && typeof val === 'object' && !Array.isArray(val) && cur && typeof cur === 'object') {
            if (Array.isArray(cur)) {
                for (const [idxKey, itemPatch] of Object.entries(val as Record<string, unknown>)) {
                    const idx = Number(idxKey);
                    if (
                        Number.isInteger(idx) &&
                        idx >= 0 &&
                        idx < cur.length &&
                        itemPatch &&
                        typeof itemPatch === 'object' &&
                        cur[idx] &&
                        typeof cur[idx] === 'object'
                    ) {
                        applyDeepPatch(cur[idx] as Record<string, unknown>, itemPatch as Record<string, unknown>);
                    }
                }
            } else {
                applyDeepPatch(cur as Record<string, unknown>, val as Record<string, unknown>);
            }
        } else {
            target[key] = val;
        }
    }
}

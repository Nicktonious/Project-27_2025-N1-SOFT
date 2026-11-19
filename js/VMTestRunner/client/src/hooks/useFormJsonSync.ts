import { useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { TestScenarioSchema, type TestScenarioInput } from '@shared/scenario.schema.ts';

export type EditorMode = 'form' | 'json';

export function useFormJsonSync(form: UseFormReturn<TestScenarioInput>) {
    const [mode, setMode] = useState<EditorMode>('form');
    const [rawJson, setRawJson] = useState<string>('');
    const [jsonError, setJsonError] = useState<string | null>(null);

    const switchMode = (nextMode: EditorMode) => {
        if (nextMode === mode) return;

        if (nextMode === 'json') {
            setRawJson(JSON.stringify(form.getValues(), null, 2));
            setJsonError(null);
            setMode('json');
            return;
        }

        try {
            const parsed = JSON.parse(rawJson);
            const result = TestScenarioSchema.safeParse(parsed);
            if (!result.success) {
                const msg = result.error.issues
                    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
                    .join('\n');
                setJsonError(msg);
                return;
            }
            form.reset(parsed);
            setJsonError(null);
            setMode('form');
        } catch (err) {
            setJsonError(err instanceof Error ? err.message : 'Некорректный синтаксис JSON');
        }
    };

    const syncFromValues = (values: TestScenarioInput) => {
        if (mode === 'json') {
            setRawJson(JSON.stringify(values, null, 2));
            setJsonError(null);
        }
    };

    return {
        mode,
        rawJson,
        setRawJson,
        jsonError,
        switchMode,
        syncFromValues,
    };
}

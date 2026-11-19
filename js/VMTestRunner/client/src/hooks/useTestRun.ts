import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    RunStatus,
    RunStatusResponse,
    StartRunRequest,
    StartRunResponse,
} from '@shared/api.contract.ts';
import type { ScenarioReport, TimelineEvent } from '@shared/scenario.schema.ts';

export function useTestRun() {
    const [runId, setRunId] = useState<string | null>(null);
    const [status, setStatus] = useState<RunStatus>('IDLE');
    const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
    const [report, setReport] = useState<ScenarioReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    const esRef = useRef<EventSource | null>(null);

    const closeStream = useCallback(() => {
        if (esRef.current) {
            esRef.current.close();
            esRef.current = null;
        }
    }, []);

    useEffect(() => closeStream, [closeStream]);

    const startRun = useCallback(
        async (payload: StartRunRequest) => {
            closeStream();
            setError(null);
            setReport(null);
            setTimeline([]);
            setStatus('RUNNING');

            try {
                const res = await fetch('/api/runs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const body = (await res.json()) as StartRunResponse & { error?: string };
                if (!res.ok) {
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                }

                setRunId(body.runId);
                setStatus(body.status);

                const es = new EventSource(`/api/runs/${body.runId}/events`);
                esRef.current = es;

                es.addEventListener('timeline', (msg) => {
                    const ev = JSON.parse((msg as MessageEvent).data) as TimelineEvent;
                    setTimeline((prev) => [...prev, ev]);
                });

                es.addEventListener('done', (msg) => {
                    const doneData = JSON.parse((msg as MessageEvent).data) as RunStatusResponse;
                    setStatus(doneData.status);
                    setReport(doneData.report);
                    if (doneData.error) setError(doneData.error);
                    es.close();
                    if (esRef.current === es) esRef.current = null;
                });

                es.onerror = () => {
                    es.close();
                    if (esRef.current === es) esRef.current = null;
                };
            } catch (err) {
                setStatus('ERROR');
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [closeStream]
    );

    const abortRun = useCallback(async () => {
        if (!runId) return;
        try {
            await fetch(`/api/runs/${runId}/abort`, { method: 'POST' });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [runId]);

    const resetRun = useCallback(() => {
        closeStream();
        setRunId(null);
        setStatus('IDLE');
        setTimeline([]);
        setReport(null);
        setError(null);
    }, [closeStream]);

    return { runId, status, timeline, report, error, startRun, abortRun, resetRun };
}

import type { RunStatus } from '@shared/api.contract.ts';
import type { ScenarioReport, TimelineEvent } from '@shared/scenario.schema.ts';
import { Accordion } from '../ui/Accordion.tsx';
import { Badge } from '../ui/Badge.tsx';
import { JsonViewer } from '../ui/JsonViewer.tsx';
import styles from './ResultsPanel.module.css';

interface ResultsPanelProps {
    runId: string | null;
    status: RunStatus;
    timeline: TimelineEvent[];
    report: ScenarioReport | null;
    error: string | null;
}

const STATUS_META: Record<RunStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
    IDLE: { label: 'Готов к запуску', tone: 'neutral' },
    RUNNING: { label: 'Выполняется...', tone: 'info' },
    COMPLETED: { label: 'Завершён', tone: 'success' },
    ABORTED: { label: 'Прерван', tone: 'warning' },
    TIMED_OUT: { label: 'Таймаут', tone: 'danger' },
    ERROR: { label: 'Ошибка', tone: 'danger' },
};

function getTimelineMsgClass(ev: TimelineEvent): string | undefined {
    if (ev.level === 'E') return styles.msgError;
    if (ev.level === 'W' || ev.kind === 'fault') return styles.msgWarn;
    if (ev.kind === 'response') return styles.msgOk;
    return undefined;
}

export function ResultsPanel({ runId, status, timeline, report, error }: ResultsPanelProps) {
    const meta = STATUS_META[status];

    return (
        <div className={styles.card}>
            <div className={styles.header}>
                <span className={styles.title}>Результаты запуска {runId ? `#${runId}` : ''}</span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
            </div>

            {error && <div className={styles.errorBox}>{error}</div>}

            {status === 'IDLE' && !report && (
                <p className={styles.hint}>
                    Настройте параметры сценария и нажмите «Запустить тест» в верхней панели.
                </p>
            )}

            {report && (
                <>
                    <div className={styles.metrics}>
                        <div className={styles.metric}>
                            <span className={styles.metricLabel}>Длительность</span>
                            <span className={styles.metricValue}>{report.durationMs} мс</span>
                        </div>
                        <div className={styles.metric}>
                            <span className={styles.metricLabel}>Операции каналов (set / get)</span>
                            <span className={styles.metricValue}>
                                {report.channelHistoryCount.set} / {report.channelHistoryCount.get}
                            </span>
                        </div>
                    </div>

                    {report.responses.length > 0 && (
                        <div>
                            <h4 className={styles.sectionTitle}>Ответы Facade ({report.responses.length})</h4>
                            <div className={styles.list}>
                                {report.responses.map((item, idx) => (
                                    <div key={`${item.Response.ID}-${idx}`} className={styles.rowItem}>
                                        <span className={styles.mono}>
                                            {item.Response.Target}
                                            {item.Response.Cell
                                                ? ` [${item.Response.Cell.row}:${item.Response.Cell.column}]`
                                                : ''}
                                        </span>
                                        <Badge tone={item.Response.Result === 'OK' ? 'success' : 'danger'}>
                                            {item.Response.Result}
                                        </Badge>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {report.sectionResults.length > 0 && (
                        <div>
                            <h4 className={styles.sectionTitle}>Результаты секции ({report.sectionResults.length})</h4>
                            <div className={styles.list}>
                                {report.sectionResults.map((res, idx) => (
                                    <div key={idx} className={styles.rowItem}>
                                        <span className={styles.mono}>
                                            {res.cell ? `Ячейка [${res.cell.row}:${res.cell.column}]` : 'Секция'}
                                        </span>
                                        <Badge tone={res.ok ? 'success' : 'danger'}>{res.ok ? 'OK' : 'FAIL'}</Badge>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {report.triggeredFaults.length > 0 && (
                        <div>
                            <h4 className={styles.sectionTitle}>Сработавшие аварии ({report.triggeredFaults.length})</h4>
                            <div className={styles.list}>
                                {report.triggeredFaults.map((f, idx) => (
                                    <div key={`${f.id}-${idx}`} className={styles.rowItem}>
                                        <span className={styles.mono}>
                                            {f.id} ({f.actionType})
                                        </span>
                                        <span className={styles.time}>+{f.triggeredAtMs} мс</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}

            {timeline.length > 0 && (
                <div>
                    <h4 className={styles.sectionTitle}>Лента событий ({timeline.length})</h4>
                    <div className={styles.timeline}>
                        {timeline.map((ev, idx) => (
                            <div key={idx} className={styles.timelineRow}>
                                <span className={styles.time}>+{ev.elapsedMs}ms</span>
                                <span className={getTimelineMsgClass(ev)}>{ev.message}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {report && (
                <Accordion title="Финальное состояние (StatesController.States)" defaultOpen={false}>
                    <JsonViewer value={(report.states ?? {}) as Record<string, unknown>} collapsed={1} />
                </Accordion>
            )}
        </div>
    );
}

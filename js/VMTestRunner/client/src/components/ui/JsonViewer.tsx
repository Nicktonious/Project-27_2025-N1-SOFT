import JsonView from '@uiw/react-json-view';
import { lightTheme } from '@uiw/react-json-view/light';
import { useState } from 'react';
import { Button } from './Button.tsx';
import styles from './JsonViewer.module.css';

interface JsonViewerProps {
    value: object;
    collapsed?: number | boolean;
    onChange?: (next: Record<string, unknown>) => void;
}

export function JsonViewer({ value, collapsed = 2, onChange }: JsonViewerProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | null>(null);

    const handleStartEdit = () => {
        setDraft(JSON.stringify(value, null, 2));
        setError(null);
        setEditing(true);
    };

    const handleApply = () => {
        try {
            const parsed = JSON.parse(draft);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                setError('Ожидается JSON-объект');
                return;
            }
            onChange?.(parsed as Record<string, unknown>);
            setError(null);
            setEditing(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Некорректный JSON');
        }
    };

    return (
        <div className={styles.container}>
            {onChange && (
                <div className={styles.toolbar}>
                    {editing ? (
                        <>
                            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                                Отмена
                            </Button>
                            <Button size="sm" variant="primary" onClick={handleApply}>
                                Применить
                            </Button>
                        </>
                    ) : (
                        <Button size="sm" variant="secondary" onClick={handleStartEdit}>
                            Редактировать JSON
                        </Button>
                    )}
                </div>
            )}

            {editing ? (
                <>
                    <textarea
                        className={styles.textarea}
                        rows={14}
                        spellCheck={false}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                    />
                    {error && <div className={styles.errorBox}>{error}</div>}
                </>
            ) : (
                <div className={styles.viewer}>
                    <JsonView value={value} style={lightTheme} collapsed={collapsed} displayDataTypes={false} />
                </div>
            )}
        </div>
    );
}

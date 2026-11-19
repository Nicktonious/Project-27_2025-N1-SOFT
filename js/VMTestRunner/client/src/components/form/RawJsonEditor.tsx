import { JsonViewer } from '../ui/JsonViewer.tsx';
import styles from './FormLayout.module.css';

interface RawJsonEditorProps {
    payload: Record<string, unknown>;
    errors: Array<{ path: string; message: string }>;
}

export function RawJsonEditor({ payload, errors }: RawJsonEditorProps) {
    return (
        <div className={styles.itemCard}>
            <span className={styles.subTitle}>REST Payload (StartRunRequest)</span>
            {errors.length > 0 && (
                <div className={styles.errorBox}>
                    {errors.map((e) => `${e.path}: ${e.message}`).join('\n')}
                </div>
            )}
            <JsonViewer value={payload} collapsed={2} />
        </div>
    );
}

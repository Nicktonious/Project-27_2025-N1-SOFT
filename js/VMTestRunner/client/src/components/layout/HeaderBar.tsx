import type { RunStatus } from '@shared/api.contract.ts';
import { Badge } from '../ui/Badge.tsx';
import { Button } from '../ui/Button.tsx';
import styles from './HeaderBar.module.css';

interface HeaderBarProps {
    isValid: boolean;
    hasMachineConfig: boolean;
    runStatus: RunStatus;
    onStartRun: () => void;
    onAbortRun: () => void;
}

export function HeaderBar({
    isValid,
    hasMachineConfig,
    runStatus,
    onStartRun,
    onAbortRun,
}: HeaderBarProps) {
    const isRunning = runStatus === 'RUNNING';

    return (
        <header className={styles.header}>
            <div className={styles.brand}>
                <span className={styles.logo}>VMTestRunner</span>
                <Badge tone={isValid ? 'success' : 'danger'}>
                    {isValid ? 'Схема валидна' : 'Ошибка валидации'}
                </Badge>
                {hasMachineConfig && <Badge tone="info">MachineConfig загружен</Badge>}
            </div>

            {hasMachineConfig && (
                <div className={styles.controls}>
                    <Button
                        variant="primary"
                        disabled={!isValid || isRunning}
                        onClick={onStartRun}
                    >
                        {isRunning ? 'Выполняется...' : 'Запустить тест'}
                    </Button>
                    <Button
                        variant="danger"
                        disabled={!isRunning}
                        onClick={onAbortRun}
                    >
                        Прервать
                    </Button>
                </div>
            )}
        </header>
    );
}

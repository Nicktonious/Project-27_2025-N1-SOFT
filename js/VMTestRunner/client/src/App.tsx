import { AppShell } from './components/layout/AppShell.tsx';
import { SectionProvider } from './context/SectionContext.tsx';

export function App() {
    return (
        <SectionProvider>
            <AppShell />
        </SectionProvider>
    );
}

export default App;

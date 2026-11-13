#!/usr/bin/env node
'use strict';
// gen.js
// CLI-утилита для сборки полного комплекта спецификации структуры MQTT v2 в единый PDF документ через Pandoc

const { spawnSync } = require('child_process');
const path = require('path');

// Парсинг аргументов командной строки
let outputPath = null;
const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output') {
        outputPath = args[++i];
    } else if (arg.startsWith('-o=')) {
        outputPath = arg.slice(3);
    } else if (arg.startsWith('--output=')) {
        outputPath = arg.slice(9);
    }
}

// Последовательность файлов спецификации
const inputFiles = [
    'index.md',
    'Конфигурация.md',
    'Состояния.md',
    'Ошибки.md',
    'Мониторинг.md',
    'Команды.md'
];

// Формирование аргументов Pandoc
// Так как cwd задан как __dirname, передаем имена файлов напрямую без длинных путей
const pandocArgs = [
    ...inputFiles,
    '--pdf-engine=weasyprint',
    '--css=style.css',
    '--toc',
    '--toc-depth=2',
    '--metadata', 'title=Спецификация структуры цифрового двойника на MQTT',
    '--metadata', "author=ООО 'МАС'",
    '--metadata', 'lang=ru-RU'
];

if (outputPath) {
    const resolvedOutput = path.resolve(process.cwd(), outputPath);
    pandocArgs.push('-o', resolvedOutput);
    console.error(`[gen.js] Запуск компиляции в файл: ${resolvedOutput}`);
} else {
    pandocArgs.push('-o', '-');
    console.error('[gen.js] Флаг -o не указан. Вывод бинарного потока PDF направлен в stdout...');
}

// Обогащение PATH путями к Pandoc, Python Scripts и библиотекам GTK/Pango (MSYS2)
const extraPaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Pandoc'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts'),
    'C:\\msys64\\ucrt64\\bin'
];
const currentPathList = (process.env.PATH || '').split(';').filter(Boolean);
for (const p of extraPaths) {
    if (p && !currentPathList.includes(p)) {
        currentPathList.unshift(p);
    }
}
const childEnv = { ...process.env, PATH: currentPathList.join(';') };

// Запуск Pandoc (shell: false для исключения разрыва аргументов с пробелами интерпретатором cmd.exe)
const result = spawnSync('pandoc', pandocArgs, {
    cwd: __dirname,
    stdio: ['inherit', 'inherit', 'inherit'],
    shell: false,
    env: childEnv
});

if (result.error) {
    console.error(`\n[gen.js] Ошибка запуска Pandoc: ${result.error.message}`);
    console.error('[gen.js] Убедитесь, что pandoc и weasyprint установлены в системе и доступны в PATH:');
    console.error('         winget install JohnMacFarlane.Pandoc');
    console.error('         pip install weasyprint');
    process.exit(1);
}

if (result.status !== 0) {
    console.error(`\n[gen.js] Pandoc завершил работу с кодом ошибки: ${result.status}`);
    process.exit(result.status || 1);
}

if (outputPath) {
    console.error('[gen.js] Успешно! PDF-документ успешно создан.');
}

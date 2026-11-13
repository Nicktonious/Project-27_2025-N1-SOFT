#!/usr/bin/env node
'use strict';
// gen.js
// CLI-утилита для сборки полного комплекта спецификации структуры MQTT v2 в единый PDF документ через Pandoc

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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

// Динамическое обнаружение глав из директории Chapters с естественной числовой сортировкой
const chaptersDir = path.join(__dirname, 'Chapters');
const chapterFiles = fs.existsSync(chaptersDir)
    ? fs.readdirSync(chaptersDir)
        .filter(f => f.endsWith('.md'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        .map(f => path.join('Chapters', f))
    : [];

// Последовательность файлов спецификации (index.md + все обнаруженные главы)
const inputFiles = [
    'index.md',
    ...chapterFiles
];

/**
 * Автоматический сбор монолитного содержания по заголовкам файлов разделов (# и ##)
 */
function generateToc(files) {
    const tocLines = [];

    for (const file of files) {
        if (file === 'index.md') continue;
        const filePath = path.isAbsolute(file) ? file : path.join(__dirname, file);
        if (!fs.existsSync(filePath)) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);

        let mainTitle = null;
        let mainAnchor = null;
        const subsections = [];

        for (const line of lines) {
            // Поиск заголовка первого уровня # Title {#anchor}
            const h1Match = line.match(/^#\s+(.+?)(?:\s+\{#([^}]+)\})?\s*$/);
            if (h1Match && !mainTitle) {
                mainTitle = h1Match[1].trim();
                mainAnchor = h1Match[2] ? h1Match[2].trim() : '';
                continue;
            }

            // Поиск заголовков второго уровня ## Title {#anchor}
            const h2Match = line.match(/^##\s+(.+?)(?:\s+\{#([^}]+)\})?\s*$/);
            if (h2Match) {
                const subTitle = h2Match[1].trim();
                const subAnchor = h2Match[2] ? h2Match[2].trim() : '';
                // Пропускаем служебные заголовки вроде "Содержание", если встретятся
                if (!subTitle.toLowerCase().startsWith('содержание')) {
                    subsections.push({ title: subTitle, anchor: subAnchor });
                }
            }
        }

        if (mainTitle) {
            const h1Link = mainAnchor ? `[${mainTitle}](#${mainAnchor})` : mainTitle;
            tocLines.push(`* **${h1Link}**`);
            for (const sub of subsections) {
                const h2Link = sub.anchor ? `[${sub.title}](#${sub.anchor})` : sub.title;
                tocLines.push(`  * ${h2Link}`);
            }
        }
    }

    return tocLines.join('\n');
}

/**
 * Обновление секции содержания в файле index.md
 */
function updateIndexToc() {
    const indexPath = path.join(__dirname, 'index.md');
    if (!fs.existsSync(indexPath)) return;

    const tocContent = generateToc(inputFiles);
    let indexContent = fs.readFileSync(indexPath, 'utf8');

    const startTag = '<!-- TOC_START -->';
    const endTag = '<!-- TOC_END -->';

    if (indexContent.includes(startTag) && indexContent.includes(endTag)) {
        const pattern = new RegExp(`${startTag}[\\s\\S]*?${endTag}`, 'm');
        const formattedToc = `${startTag}\n\n::: {#TOC}\n\n${tocContent}\n\n:::\n\n${endTag}`;
        indexContent = indexContent.replace(pattern, formattedToc);
        fs.writeFileSync(indexPath, indexContent, 'utf8');
        console.error(`[gen.js] Монолитное содержание в index.md обновлено (глав обнаружено: ${chapterFiles.length}).`);
    }
}

// Автоматическая генерация монолитного содержания в index.md перед сборкой
updateIndexToc();

// Формирование аргументов Pandoc
const pandocArgs = [
    ...inputFiles,
    '--pdf-engine=weasyprint',
    '--css=style.css',
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

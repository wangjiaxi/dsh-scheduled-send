#!/usr/bin/env node
/**
 * Manifest and bundle sanity checks for dsh-scheduled-send.
 *
 * Run with `npm run validate` (also the GitHub Actions job). It only checks
 * what a DSH loader would read before mounting the package: the manifest, the
 * bundle patch, the exports map, the locale metadata, the icon, and the client
 * module's registration id. It needs no running Harness, network, or
 * dependencies.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

/** @param {string} message - 失败项。 */
function fail(message) {
	problems.push(message)
}

/**
 * @param {string} relative - 相对包根的路径。
 * @returns {any} 解析后的 JSON。
 */
function readJson(relative) {
	const path = join(root, relative)
	if (!existsSync(path)) {
		fail(`${relative}: missing`)
		return undefined
	}
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		fail(`${relative}: invalid JSON (${error.message})`)
		return undefined
	}
}

/**
 * @param {string} relative - 相对包根的路径。
 * @returns {string} 文件内容，缺失时为空串。
 */
function readText(relative) {
	const path = join(root, relative)
	if (!existsSync(path)) {
		fail(`${relative}: missing`)
		return ''
	}
	return readFileSync(path, 'utf8')
}

const manifest = readJson('package.json')
if (manifest) {
	for (const field of ['name', 'version', 'license', 'description']) {
		if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') fail(`package.json: "${field}" must be a non-empty string`)
	}
	if (manifest.private === true) fail('package.json: "private": true blocks npm publishing')
	if ((manifest.repository?.url ?? '').includes('YOUR_GITHUB')) notes.push('package.json: repository.url still holds the YOUR_GITHUB placeholder')

	const bundle = manifest.dsh?.bundle
	if (typeof bundle?.patch !== 'string') fail('package.json: dsh.bundle.patch must point at the bundle patch')
	else {
		const patch = readText(bundle.patch.replace(/^\.\//, ''))
		if (patch !== '') {
			if (!/^- insert:/m.test(patch)) fail(`${bundle.patch}: no "- insert:" list`)
			if (!patch.includes(`name: ${manifest.name}`)) fail(`${bundle.patch}: no row names ${manifest.name}`)
			if (!patch.includes('id:')) fail(`${bundle.patch}: the inserted row has no id`)
		}
	}

	const client = manifest.dsh?.client
	if (client?.platform !== 'web') fail('package.json: dsh.client.platform must be "web"')
	if (client !== undefined && client.immediately !== true) notes.push('package.json: dsh.client.immediately is not true — the trigger would only load on demand')
	if (client !== undefined && !Array.isArray(client.inject)) fail('package.json: dsh.client.inject must be an array of client package ids')

	for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
		const relative = typeof target === 'string' ? target : target?.default
		if (typeof relative !== 'string') {
			fail(`package.json: exports["${subpath}"] must resolve to a file`)
			continue
		}
		if (relative.includes('*')) continue
		if (!existsSync(join(root, relative))) fail(`package.json: exports["${subpath}"] -> ${relative} is missing`)
	}

	for (const entry of manifest.files ?? []) {
		if (entry.includes('*')) {
			const prefix = entry.replace(/\*.*$/, '')
			if (prefix !== '' && !existsSync(join(root, prefix.replace(/\/$/, '')))) fail(`package.json: files entry "${entry}" has no matching directory`)
			continue
		}
		if (!existsSync(join(root, entry))) fail(`package.json: files entry "${entry}" is missing on disk`)
	}

	const source = readText('client.js')
	if (source !== '') {
		if (!source.includes('window.__ModuleLoader__.load(')) fail('client.js: no window.__ModuleLoader__.load() registration')
		if (!source.includes(`id: "${manifest.name}"`)) fail(`client.js: the module id must be "${manifest.name}" (double-quoted)`)
		for (const symbol of ['exports.apply', 'exports.inject']) {
			if (!source.includes(symbol)) fail(`client.js: ${symbol} is not exported`)
		}
		if (/import\s.+from\s+["']@deepseek-ai\//.test(source)) fail('client.js: a client bundle must not import a Harness Client package')
		if (!source.includes("'conversation.input.right'")) fail('client.js: the trigger must register into conversation.input.right')
	}

	const host = readText('index.js')
	if (host !== '' && !/export function apply\b/.test(host)) fail('index.js: the Host half must export apply()')
	if (host !== '' && !host.includes('ctx.sessionController.prompt(')) fail('index.js: delivery must go through ctx.sessionController.prompt()')

	for (const locale of ['en', 'zh']) {
		const dict = readJson(`locale/${locale}.json`)
		if (dict === undefined) continue
		if (typeof dict.meta?.title !== 'string' || dict.meta.title.trim() === '') fail(`locale/${locale}.json: meta.title is empty`)
		if (typeof dict.meta?.description !== 'string' || dict.meta.description.trim() === '') fail(`locale/${locale}.json: meta.description is empty`)
	}

	const icon = readText('icon.svg')
	if (icon !== '' && !/^<svg[\s>]/.test(icon.trim())) fail('icon.svg: does not start with an <svg> root element')
}

if (notes.length > 0) {
	process.stdout.write('notes:\n')
	for (const note of notes) process.stdout.write(`  - ${note}\n`)
}

if (problems.length > 0) {
	process.stdout.write('problems:\n')
	for (const problem of problems) process.stdout.write(`  - ${problem}\n`)
	process.exitCode = 1
} else {
	process.stdout.write(`ok: ${manifest?.name}@${manifest?.version} manifest, patch, exports, locale, icon and client registration\n`)
}

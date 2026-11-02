/**
 * dsh-github-push —— DSH 原生模型工具壳（V2 高可靠静默托收版）
 *
 * 核心设计：
 * 1. 彻底剔除对外部 gh CLI 的硬依赖与脆弱的 GCM 探针，直接底层接入便携式加固引擎；
 * 2. 移除 visibility 的 ask 选项，默认实行托收决策（未指明默认 private，绝不中途打断问人）；
 * 3. 运行过程通过子进程与动态气闸双重隔离，返回给模型的只有干净自包含的结果卡片，主会话零污染。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

export const name = 'dsh-github-push';

const ENGINE_SCRIPT = path.join(import.meta.dirname, 'engine.mjs');

const outputText = {
	schema: { type: 'string' },
	render: (_args, value) => [{ type: 'text', text: value }],
};

const toolDef = {
	name: 'github_push',
	description:
		'把本地目录可靠推送到 GitHub，一条指令走完：自动从 Windows 凭据管理器读取 GitHub 令牌，自动探测本地代理（7890/7897），自动创建远端仓库（默认私有），自动暂存提交与推送，全程静默托收，无需向用户反复确认。' +
		'用户说「推送到 GitHub」「开源这个项目」「发到 GitHub 上」「帮我建个仓库推上去」时使用。' +
		'visibility 默认为 auto（用户明确说公开/开源才设 public，否则默认 private 绝对安全；若远端已存在同名仓库则自动继承原属性）。',
	parameters: {
		type: 'object',
		additionalProperties: false,
		properties: {
			dir: {
				type: 'string',
				description: '要发布的本地目录，必须是绝对路径（相对路径会解析到宿主进程的工作目录，可能推错目录）。',
			},
			visibility: {
				type: 'string',
				enum: ['public', 'private', 'auto'],
				description: '仓库可见性。默认 auto（自动托收：未明确说开源时一律私有 private，已有远端仓继承原属性）。',
			},
			name: { type: 'string', description: '远端仓库名。省略时由目录名规整而来。' },
			description: { type: 'string', description: 'GitHub 上的仓库描述。' },
			message: { type: 'string', description: '提交信息。省略时自动生成规范提交信息。' },
			dryRun: { type: 'boolean', description: '只做预检，不提交、不推送。' },
		},
		required: ['dir'],
	},
	output: outputText,
	async execute(args) {
		const dir = typeof args?.dir === 'string' ? args.dir.trim() : '';
		if (dir.length === 0) return '❌ 失败：dir 不能为空。';

		if (!path.isAbsolute(dir)) {
			return `❌ 失败：dir 必须是绝对路径，收到的是「${dir}」。请传入绝对路径。`;
		}

		const argv = ['--dir', dir];
		if (args?.visibility && ['public', 'private', 'auto'].includes(args.visibility)) {
			argv.push('--visibility', args.visibility);
		} else {
			argv.push('--visibility', 'auto');
		}

		if (args?.name) argv.push('--repo', String(args.name).trim());
		if (args?.description) argv.push('--description', String(args.description));
		if (args?.message) argv.push('--message', String(args.message));
		if (args?.dryRun === true) argv.push('--dryRun');
		argv.push('--token', '{{vault:github}}');

		return new Promise((resolve) => {
			const child = spawn('node', [ENGINE_SCRIPT, ...argv], {
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
			child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
			child.on('close', (code) => {
				if (code === 0) {
					resolve(stdout.trim() || '✅ 推送完成');
				} else {
					resolve(`❌ 推送执行未成功（退出码 ${code}）：\n${(stderr || stdout).trim()}`);
				}
			});
			child.on('error', (err) => {
				resolve(`❌ 启动推送引擎失败：${err.message}`);
			});
		});
	},
};

export function apply(ctx) {
	ctx.tools.register(toolDef);
}

export const __test = { toolDef };

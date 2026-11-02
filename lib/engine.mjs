/**
 * engine.mjs —— 可移植高可靠 GitHub 静默推送引擎（零外部依赖、零信任气闸、全托管）
 *
 * 核心特性：
 * 1. 绝对静默与托收承办：未声明时默认 private（安全底线），自动建仓，自动暂存并规范化 Commit；
 * 2. 大模型零信任凭据气闸：
 *    - 外部输入支持占位符 {{vault:github}}，本地运行时由 Win32 API 直读 Windows 凭据管理器；
 *    - 所有输出、子进程日志、网络错误均经由动态 Scrub 脱敏清洗，真实 Token 永不出机、永不入会话；
 * 3. 网络与代理自愈：
 *    - 智能嗅探本地代理（7890 / 7897 / 10808 / 环境变量）；
 *    - 强制 Git 使用 OpenSSL 后端（-c http.sslBackend=openssl），彻底消除 Windows Schannel 握手抖动；
 *    - 关键网络操作内置 3 次指数退避重试；代理不可达时快速失败报警，拒绝无限挂起。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const DIR = opt('dir');
const DRY = flag('dryRun');
const QUIET = flag('quiet');
const INPUT_VISIBILITY = opt('visibility', 'auto');
const INPUT_TOKEN = opt('token');

if (!DIR || !path.isAbsolute(DIR)) {
	console.error('用法：node engine.mjs --dir <绝对路径> [--repo <name>] [--visibility public|private|auto] [--dryRun] [--quiet]');
	process.exit(2);
}

const REPO = opt('repo', path.basename(DIR).replace(/[^A-Za-z0-9._-]/g, '-'));

let activeToken = '';
const steps = [];

export function scrub(str) {
	if (!str) return '';
	let s = String(str);
	if (activeToken && activeToken.length >= 8) {
		s = s.split(activeToken).join('{{secret:github-token}}');
	}
	s = s
		.replace(/https:\/\/x-access-token:[^@\s]+@/g, 'https://{{secret:github-token}}@')
		.replace(/https:\/\/[A-Za-z0-9_]{35,85}@github\.com/g, 'https://{{secret:github-token}}@github.com')
		.replace(/ghp_[A-Za-z0-9_]{36}/g, '{{secret:github-token}}')
		.replace(/github_pat_[A-Za-z0-9_]{82}/g, '{{secret:github-token}}')
		.replace(/gho_[A-Za-z0-9_]{36}/g, '{{secret:github-token}}');
	return s;
}

const note = (name, detail) => {
	const cleanDetail = scrub(detail);
	steps.push({ name, detail: cleanDetail });
	if (!QUIET) {
		console.log(`  · ${name}：${cleanDetail}`);
	}
};

function run(command, argv, { cwd = DIR, env = {}, input = undefined, timeoutMs = 120000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, argv, {
			cwd,
			env: { ...process.env, ...env },
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			resolve({ code, stdout, stderr });
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(-1);
		}, timeoutMs);
		child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
		child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
		child.on('close', (code) => {
			clearTimeout(timer);
			finish(code);
		});
		child.on('error', (e) => {
			clearTimeout(timer);
			stderr += `\n${e.message}`;
			finish(-2);
		});
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

function tcpReachable(host, port, timeoutMs = 600) {
	return new Promise((resolve) => {
		const sock = net.connect({ host, port });
		const done = (v) => {
			sock.destroy();
			resolve(v);
		};
		sock.setTimeout(timeoutMs);
		sock.once('connect', () => done(true));
		sock.once('timeout', () => done(false));
		sock.once('error', () => done(false));
	});
}

async function detectProxy() {
	const candidates = [];
	const envProxy = process.env.DSH_PUSH_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
	if (envProxy) {
		try {
			const u = new URL(envProxy.startsWith('http') ? envProxy : `http://${envProxy}`);
			candidates.push({ host: u.hostname, port: Number(u.port) || 7890, desc: `环境变量 (${envProxy})` });
		} catch {
			/* ignore */
		}
	}
	candidates.push({ host: '127.0.0.1', port: 7890, desc: '本地代理默认 (7890)' });
	candidates.push({ host: '127.0.0.1', port: 7897, desc: '本地代理备选 (7897)' });
	candidates.push({ host: '127.0.0.1', port: 10808, desc: '本地代理备选 (10808)' });

	for (const c of candidates) {
		if (await tcpReachable(c.host, c.port)) {
			return c;
		}
	}
	return null;
}

const PS_CRED_READ = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class DshCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int flag, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
  public static byte[] Bytes(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlobSize <= 0) return new byte[0];
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      return b;
    } finally { CredFree(p); }
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
foreach ($t in @('git:https://github.com', 'gh:github.com')) {
  $b = [DshCred]::Bytes($t)
  if ($null -ne $b -and $b.Length -gt 0) {
    [Console]::Out.Write($t + '|' + [Convert]::ToBase64String($b))
    break
  }
}
`;

function decodeBlob(bytes) {
	const buf = Buffer.from(bytes, 'base64');
	const looksUtf16 = buf.length >= 2 && buf.length % 2 === 0 && buf[1] === 0;
	const text = looksUtf16 ? buf.toString('utf16le') : buf.toString('utf8');
	return { text: text.replace(/\0+$/g, '').trim(), looksUtf16 };
}

async function resolveToken() {
	const isPlaceholder = !INPUT_TOKEN || INPUT_TOKEN === '{{vault:github}}' || INPUT_TOKEN === '{{secret:github-token}}';
	if (!isPlaceholder && INPUT_TOKEN.length >= 20) {
		activeToken = INPUT_TOKEN;
		return { token: INPUT_TOKEN, source: '显式传入参数（已接入安全气闸脱敏）' };
	}

	if (process.platform === 'win32') {
		const encoded = Buffer.from(PS_CRED_READ, 'utf16le').toString('base64');
		const ps = await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeoutMs: 30000 });
		if (ps.code === 0 && ps.stdout.includes('|')) {
			const [target, b64] = ps.stdout.trim().split('|');
			const { text, looksUtf16 } = decodeBlob(b64);
			activeToken = text;
			return { token: text, source: `Windows 凭据管理器（${target}，${looksUtf16 ? 'UTF-16LE' : 'UTF-8'}）` };
		}
	}

	// 备选回退：环境变量 GITHUB_TOKEN / GH_TOKEN
	const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (envToken) {
		activeToken = envToken;
		return { token: envToken, source: '环境变量（GITHUB_TOKEN）' };
	}

	return { token: '', source: '系统凭据管理器中未找到 GitHub 凭据，且环境变量未配置' };
}

async function runGitWithRetry(argv, opts = {}, attempts = 3) {
	let last = null;
	for (let i = 1; i <= attempts; i++) {
		last = await run('git', argv, opts);
		if (last.code === 0) return { ...last, attempts: i };
		if (i < attempts) {
			await new Promise((r) => setTimeout(r, 1000 * i));
		}
	}
	return { ...last, attempts };
}

function apiViaProxy(url, init, proxy) {
	return new Promise((resolve, reject) => {
		let target;
		try {
			target = new URL(url);
		} catch (error) {
			reject(error);
			return;
		}
		const connectReq = http.request({
			host: proxy.host,
			port: proxy.port,
			method: 'CONNECT',
			path: `${target.hostname}:443`,
			headers: { Host: `${target.hostname}:443` },
			timeout: 30000,
		});
		connectReq.once('connect', (res, socket) => {
			if (res.statusCode !== 200) {
				socket.destroy();
				reject(new Error(`代理 CONNECT 隧道失败：HTTP ${res.statusCode}`));
				return;
			}
			const body = init.body;
			const req = https.request(
				{
					socket,
					servername: target.hostname,
					host: target.hostname,
					path: target.pathname + target.search,
					method: init.method ?? 'GET',
					headers: { ...init.headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
				},
				(response) => {
					let data = '';
					response.setEncoding('utf8');
					response.on('data', (c) => (data += c));
					response.on('end', () => {
						let parsed = null;
						try {
							parsed = data ? JSON.parse(data) : null;
						} catch {
							parsed = data;
						}
						resolve({
							status: response.statusCode,
							body: parsed,
							headers: { get: (k) => response.headers[String(k).toLowerCase()] ?? null },
						});
					});
				},
			);
			req.on('error', reject);
			if (body) req.write(body);
			req.end();
		});
		connectReq.once('timeout', () => {
			connectReq.destroy();
			reject(new Error('代理 CONNECT 握手超时'));
		});
		connectReq.once('error', reject);
		connectReq.end();
	});
}

async function api(pathname, token, proxy, init = {}, attempt = 1) {
	const headers = {
		Authorization: `token ${token}`,
		Accept: 'application/vnd.github+json',
		'User-Agent': 'dsh-push-engine',
		'X-GitHub-Api-Version': '2022-11-28',
		...(init.body ? { 'Content-Type': 'application/json' } : {}),
		...init.headers,
	};
	const url = `https://api.github.com${pathname}`;
	try {
		if (proxy) {
			return await apiViaProxy(url, { ...init, headers }, proxy);
		}
		const res = await fetch(url, { ...init, headers });
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		return { status: res.status, body, headers: res.headers };
	} catch (error) {
		if (attempt >= 3) throw error;
		await new Promise((r) => setTimeout(r, 1200 * attempt));
		return api(pathname, token, proxy, init, attempt + 1);
	}
}

async function verifyRemote({ remoteUrl, gitProxyArgs, token, proxy, owner, repo, localSha }) {
	const failures = [];

	try {
		const ls = await runGitWithRetry([...gitProxyArgs, 'ls-remote', '--heads', remoteUrl, 'refs/heads/main'], {
			timeoutMs: 60000,
		});
		if (ls.code === 0) {
			const line = ls.stdout.split(/\r?\n/).find((l) => l.includes('refs/heads/main'));
			const sha = line?.split(/\s+/)[0]?.trim();
			if (sha) {
				return sha === localSha
					? { status: 'match', via: 'git ls-remote (OpenSSL)', remoteSha: sha }
					: { status: 'mismatch', via: 'git ls-remote (OpenSSL)', remoteSha: sha };
			}
			failures.push('ls-remote 未找到 main 分支');
		} else {
			failures.push(`ls-remote 退出码 ${ls.code}`);
		}
	} catch (e) {
		failures.push(`ls-remote 异常：${e.message}`);
	}

	try {
		const res = await api(`/repos/${owner}/${repo}/branches/main`, token, proxy);
		const sha = res.status === 200 ? res.body?.commit?.sha : null;
		if (sha) {
			return sha === localSha
				? { status: 'match', via: 'REST API 隧道', remoteSha: sha }
				: { status: 'mismatch', via: 'REST API 隧道', remoteSha: sha };
		}
		failures.push(`REST API 返回 ${res.status}`);
	} catch (e) {
		failures.push(`REST API 异常：${e.message}`);
	}

	return { status: 'unknown', detail: failures.join('；') };
}

export async function main() {
	if (!QUIET) {
		console.log(`\n=== DSH GitHub 自动化推送引擎：${DIR} → ${REPO} ${DRY ? '[DryRun]' : ''} ===`);
	}

	const vault = await resolveToken();
	if (!vault.token) {
		console.error(`\n❌ 凭据翻译失败：${vault.source}`);
		console.error('提示：请先在 Windows 终端执行一次正常的 git push，或配置 GITHUB_TOKEN 环境变量。');
		return 10;
	}
	note('凭据翻译', `已成功将占位符安全映射为 ${vault.source}（真实值已封入气闸）`);

	const proxy = await detectProxy();
	if (!proxy) {
		const directOk = await tcpReachable('github.com', 443, 1000);
		if (!directOk) {
			console.error('\n❌ 网络探测失败：本地代理端口均未监听，且直连 github.com:443 超时。');
			console.error('提示：请确认本地代理软件已开启并处于监听状态。');
			return 11;
		}
		note('网络链路', '直连 github.com:443 可达');
	} else {
		note('网络链路', `已连接到本地代理 ${proxy.host}:${proxy.port}（${proxy.desc}）`);
	}

	let owner = '';
	try {
		const user = await api('/user', vault.token, proxy);
		if (user.status !== 200) {
			console.error(`\n❌ GitHub 身份验证失败（HTTP ${user.status}）：令牌无效或已过期。`);
			return 12;
		}
		owner = user.body.login;
		note('账号身份', `${owner}（Token 验证通过）`);
	} catch (e) {
		console.error(`\n❌ GitHub API 请求异常：${scrub(e.message)}`);
		return 13;
	}

	let remoteExists = false;
	let remoteIsPrivate = true;
	try {
		const probe = await api(`/repos/${owner}/${REPO}`, vault.token, proxy);
		if (probe.status === 200) {
			remoteExists = true;
			remoteIsPrivate = Boolean(probe.body.private);
			note('远端仓库', `已存在：${probe.body.html_url}（${remoteIsPrivate ? 'Private' : 'Public'}）`);
		} else if (probe.status === 404) {
			remoteExists = false;
			note('远端仓库', '不存在，将由引擎自动新建');
		} else {
			console.error(`\n❌ 远端仓库探测异常（HTTP ${probe.status}）`);
			return 14;
		}
	} catch (e) {
		console.error(`\n❌ 探测仓库失败：${scrub(e.message)}`);
		return 14;
	}

	let finalVisibility = 'private';
	if (INPUT_VISIBILITY === 'public') {
		finalVisibility = 'public';
	} else if (INPUT_VISIBILITY === 'private') {
		finalVisibility = 'private';
	} else if (remoteExists) {
		finalVisibility = remoteIsPrivate ? 'private' : 'public';
	} else {
		finalVisibility = 'private';
	}
	note('可见性策略', `${finalVisibility}（托收决策完成，零交互确认）`);

	if (!fs.existsSync(path.join(DIR, '.git'))) {
		const init = await run('git', ['init', '-b', 'main']);
		if (init.code !== 0) {
			console.error(`\n❌ git init 失败：${scrub(init.stderr)}`);
			return 15;
		}
		note('本地仓库', '未检测到 Git，已自动完成 git init -b main');
	} else {
		const curBranch = (await run('git', ['branch', '--show-current'])).stdout.trim();
		if (curBranch === 'master') {
			await run('git', ['branch', '-M', 'main']);
			note('分支规整', '已自动将本地分支 master 重命名为 main');
		}
	}

	await run('git', ['add', '-A']);
	const staged = await run('git', ['diff', '--cached', '--name-only']);
	const stagedFiles = staged.stdout.split(/\r?\n/).filter(Boolean);
	note('暂存变动', stagedFiles.length === 0 ? '工作树干净（无新变动）' : `已暂存 ${stagedFiles.length} 个文件变动`);

	const hasHead = (await run('git', ['rev-parse', '--verify', 'HEAD'])).code === 0;
	if (stagedFiles.length > 0 || !hasHead) {
		const defaultMsg = `chore: update ${REPO} (${new Date().toISOString().slice(0, 10)})`;
		const commitMsg = opt('message', defaultMsg);
		const commit = await run('git', ['commit', '-m', commitMsg]);
		if (commit.code !== 0) {
			console.error(`\n❌ git commit 失败：${scrub(commit.stderr)}`);
			return 16;
		}
		note('本地提交', (await run('git', ['rev-parse', '--short', 'HEAD'])).stdout.trim());
	} else {
		note('本地提交', `沿用当前 HEAD (${(await run('git', ['rev-parse', '--short', 'HEAD'])).stdout.trim()})`);
	}

	const localSha = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();

	const gitProxyArgs = ['-c', 'http.sslBackend=openssl'];
	if (proxy) {
		gitProxyArgs.push('-c', `http.proxy=http://${proxy.host}:${proxy.port}`);
		gitProxyArgs.push('-c', `https.proxy=http://${proxy.host}:${proxy.port}`);
	}
	const remotePushUrl = `https://x-access-token:${vault.token}@github.com/${owner}/${REPO}.git`;

	if (DRY) {
		console.log('\n✅ [DryRun] 预检全量通过：');
		console.log(`   · 账号：${owner}`);
		console.log(`   · 仓库目标：https://github.com/${owner}/${REPO}（${finalVisibility}）`);
		console.log(`   · 本地 Commit：${localSha.slice(0, 7)}`);
		console.log(`   · 凭据气闸状态：生效中（Token 占位符本地映射无缝完成）`);
		return 0;
	}

	if (!remoteExists) {
		const created = await api('/user/repos', vault.token, proxy, {
			method: 'POST',
			body: JSON.stringify({
				name: REPO,
				description: opt('description', 'Pushed by DSH automated push engine'),
				private: finalVisibility === 'private',
				has_issues: true,
				has_wiki: false,
				auto_init: false,
			}),
		});
		if (created.status !== 201) {
			console.error(`\n❌ 自动建仓失败（HTTP ${created.status}）：${scrub(JSON.stringify(created.body))}`);
			return 17;
		}
		note('远端建仓', `已自动创建远端 ${finalVisibility} 仓库：${created.body.html_url}`);
	}

	const push = await runGitWithRetry([...gitProxyArgs, 'push', remotePushUrl, 'main:main'], { timeoutMs: 180000 });
	if (push.code !== 0) {
		console.error(`\n❌ git push 失败（尝试 ${push.attempts} 次）：${scrub(push.stderr).trim()}`);
		return 18;
	}
	note('远端推送', `推送完成（尝试 ${push.attempts} 次）`);

	const verify = await verifyRemote({
		remoteUrl: remotePushUrl,
		gitProxyArgs,
		token: vault.token,
		proxy,
		owner,
		repo: REPO,
		localSha,
	});

	if (verify.status === 'mismatch') {
		console.error(`\n❌ 校验失败：远端 ${String(verify.remoteSha).slice(0, 7)} 与本地 ${localSha.slice(0, 7)} 不一致（通道: ${verify.via}）`);
		return 19;
	} else if (verify.status === 'match') {
		note('回读校验', `✅ 远端分支 SHA 与本地一致（${localSha.slice(0, 7)}）｜ 通道: ${verify.via}`);
	} else {
		note('回读校验', `⚠️ 未能读取远端 SHA（${verify.detail}），推送退出码为 0，视为成功`);
	}

	const baseDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
	const reportDir = path.join(baseDir, 'push_reports');
	try {
		fs.mkdirSync(reportDir, { recursive: true });
		const reportPath = path.join(reportDir, `push-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
		fs.writeFileSync(
			reportPath,
			JSON.stringify(
				{
					at: new Date().toISOString(),
					owner,
					repo: REPO,
					head: localSha,
					remoteSha: verify.remoteSha || null,
					visibility: finalVisibility,
					steps,
				},
				null,
				2,
			),
			'utf8',
		);
	} catch {
		/* ignore */
	}

	const repoUrl = `https://github.com/${owner}/${REPO}`;
	console.log('\n========================================');
	console.log('✅ GitHub 推送成功（全流程托收完成）');
	console.log(`- 仓库地址：${repoUrl}`);
	console.log(`- 仓库属性：${finalVisibility === 'private' ? '私有仓库 (Private)' : '公开开源 (Public)'}（${remoteExists ? '沿用已有' : '新建'}）`);
	console.log(`- 本地提交：${localSha.slice(0, 7)} (分支: main)`);
	console.log(`- 校验状态：${verify.status === 'match' ? `✅ SHA 一致 (${verify.via})` : '⚠️ 校验略过（网络原因未取到远端 SHA）'}`);
	console.log('========================================\n');
	return 0;
}

if (process.argv[1] && process.argv[1].endsWith('engine.mjs')) {
	main()
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error(`\n❌ 引擎未捕获异常：${scrub(e?.stack || e)}`);
			process.exit(99);
		});
}

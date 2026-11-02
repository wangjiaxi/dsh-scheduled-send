/**
 * dsh-scheduled-send — 客户端（发送按钮旁的那个箭头 + 定时对话框）。
 *
 * 只占输入框工具栏里的一个格子：`conversation.input.right`，紧挨着发送按钮。
 * 点箭头 → 选日期时间 → 「定时发送」；真正到点投递由宿主负责（见 index.js），
 * 所以页面关掉、切到别的会话都不影响。
 *
 * @module dsh-scheduled-send/client
 */
window.__ModuleLoader__.load({
	id: "dsh-scheduled-send",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** 本地化命名空间。 */
		const NS = 'dsh-scheduled-send';
		/** 宿主端路由前缀。 */
		const API = '/dsh-scheduled-send/api';
		/** 待发送列表的自动刷新间隔。 */
		const REFRESH_MS = 60_000;
		/** 「已排上」提示的停留时长。 */
		const TOAST_MS = 4_000;
		/** 与宿主端保持一致的长度上限。 */
		const MAX_TEXT_CHARS = 20_000;
		/** 与宿主端保持一致的最大提前量。 */
		const MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;

		// #region i18n
		const zh = {
			tip: '定时消息',
			title: '定时消息',
			date: '日期',
			time: '时间',
			cancel: '取消',
			confirm: '定时发送',
			busy: '正在排…',
			close: '关闭',
			previewEmpty: '输入框里还没有内容——先写点要发的话',
			pendingTitle: '待发送',
			remove: '撤销这条',
			preset10: '10 分钟后',
			preset30: '30 分钟后',
			preset60: '1 小时后',
			presetTomorrow: '明天 9:00',
			today: '今天',
			tomorrow: '明天',
			scheduledAt: '已排到 {when}',
			badge: '{count} 条待发送',
			errEmpty: '输入框是空的，先写点内容',
			errAttachments: '定时发送暂不支持附件，先去掉附件',
			errTime: '这个日期或时间不合法',
			errPast: '时间要晚于现在',
			errTooFar: '最多只能排到一年以内',
			errTooLong: '这条太长了，{limit} 字以内',
			errTimeZone: '浏览器时区不合法',
			errSession: '当前会话还没准备好，刷新一下再试',
			errNetwork: '网络异常，这条没有排上',
			errServer: '宿主没有接受这条定时消息'
		};
		const en = {
			tip: 'Schedule message',
			title: 'Schedule message',
			date: 'Date',
			time: 'Time',
			cancel: 'Cancel',
			confirm: 'Schedule',
			busy: 'Scheduling…',
			close: 'Close',
			previewEmpty: 'The composer is empty — write the message first',
			pendingTitle: 'Queued',
			remove: 'Remove this one',
			preset10: 'In 10 min',
			preset30: 'In 30 min',
			preset60: 'In 1 hour',
			presetTomorrow: 'Tomorrow 9:00',
			today: 'today',
			tomorrow: 'tomorrow',
			scheduledAt: 'Queued for {when}',
			badge: '{count} queued',
			errEmpty: 'The composer is empty — write the message first',
			errAttachments: 'Scheduled send cannot carry attachments yet — remove them first',
			errTime: 'That date or time is not valid',
			errPast: 'Pick a time in the future',
			errTooFar: 'You can schedule at most one year ahead',
			errTooLong: 'Too long — at most {limit} characters',
			errTimeZone: 'This browser reports an invalid time zone',
			errSession: 'The current session is not ready — reload and retry',
			errNetwork: 'Network error — nothing was queued',
			errServer: 'The host rejected this scheduled message'
		};

		/** `ctx.locale.bind(NS)` 的结果；拿不到就退回内置词典。 */
		let bound = null;
		/** 从浏览器语言猜的兜底语言。 */
		let fallbackLang = (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')) ? 'zh' : 'en';

		/**
		 * 取一条文案。
		 *
		 * @param {string} key - 文案键。
		 * @param {Record<string, unknown>} [params] - `{name}` 占位符。
		 * @returns {string} 文案。
		 */
		function t(key, params) {
			let text;
			if (typeof bound === 'function') {
				try {
					const value = bound(key, params);
					if (typeof value === 'string' && value !== '' && value !== key) text = value;
				} catch {
					text = undefined;
				}
			}
			if (text === undefined) {
				const dict = fallbackLang === 'zh' ? zh : en;
				text = typeof dict[key] === 'string' ? dict[key] : (typeof en[key] === 'string' ? en[key] : key);
			}
			if (params !== undefined && params !== null) {
				for (const name of Object.keys(params)) {
					text = text.split('{' + name + '}').join(String(params[name]));
				}
			}
			return text;
		}
		// #endregion

		// #region styles
		const CSS = [
			// 抽出来占满「工具栏里自己那格」的右边，再右移贴住宿主的发送按钮。
			// 24px 是量出来的：.trailing 的 12px 间距 + 中间那个 0 宽空槽又贡献 12px。
			// 万一这个数变小，多出来的部分会钻到发送按钮底下（后画的按钮盖住我），
			// 所以宁可多移一点，也别留缝；图标靠左放，被盖掉一些也不会缺角。
			'.dss-anchor{position:relative;right:-24px;order:999;display:inline-flex;align-items:center}',
			// 发送按钮的左半段：和宿主那颗圆形按钮拼成同一颗蓝胶囊。
			'.dss-trigger{position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:34px;padding:0 0 0 6px;border:0;border-radius:999px 0 0 999px;background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary,#4d6bfe));color:#fff;cursor:pointer;transform:translateY(-2px);transition:background-color .1s}',
			'.dss-trigger:hover:not([data-dim="1"]){background:var(--dsw-alias-button-info-hover,var(--dsw-alias-brand-primary,#4d6bfe))}',
			'.dss-trigger:focus-visible{outline:2px solid #fff;outline-offset:-3px}',
			'.dss-trigger[data-dim="1"]{opacity:.4;cursor:default}',
			// 有排队时的小白点，代替原来的数字角标（26px 宽塞不下数字）。
			'.dss-dot{position:absolute;top:5px;right:7px;width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgba(15,18,24,.16)}',
			'.dss-tip{position:absolute;bottom:calc(100% + 8px);right:0;z-index:30;padding:5px 9px;border-radius:8px;background:rgba(24,28,36,.94);color:#fff;font-size:12px;line-height:1.4;white-space:nowrap;opacity:0;pointer-events:none;transform:translateY(2px);transition:opacity .12s ease,transform .12s ease}',
			'.dss-anchor:hover .dss-tip,.dss-anchor:focus-within .dss-tip{opacity:1;transform:translateY(0)}',
			'.dss-toast{position:absolute;bottom:calc(100% + 10px);right:0;z-index:31;max-width:280px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:1.45}',
			'.dss-backdrop{position:fixed;inset:0;z-index:2140;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,18,24,.42);animation:dss-fade .12s ease}',
			'.dss-card{width:min(440px,100%);max-height:calc(100vh - 48px);overflow:auto;padding:20px 22px 18px;border-radius:16px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));box-shadow:0 24px 64px rgba(0,0,0,.28);font-size:14px;line-height:1.5}',
			'.dss-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}',
			'.dss-title{font-size:16px;font-weight:600}',
			'.dss-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer}',
			'.dss-close:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328)}',
			'.dss-preview{padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f5f6f8);color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto;margin-bottom:14px}',
			'.dss-preview-empty{color:var(--dsw-alias-label-secondary,#8a8f98)}',
			'.dss-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
			'.dss-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
			'.dss-label{font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98)}',
			'.dss-input{height:38px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:14px;outline:none;min-width:0;width:100%;box-sizing:border-box}',
			'.dss-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary,#4d6bfe) 18%, transparent)}',
			'.dss-input::-webkit-calendar-picker-indicator{opacity:.55;cursor:pointer}',
			'.dss-presets{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}',
			'.dss-chip{padding:4px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);font-size:12px;cursor:pointer}',
			'.dss-chip:hover{color:var(--dsw-alias-label-primary,#1f2328);border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.32))}',
			'.dss-error{margin-top:10px;color:var(--dsw-alias-state-error-primary,#d93025);font-size:12px;line-height:1.5}',
			'.dss-pending{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
			'.dss-pending-head{font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98);margin-bottom:4px}',
			'.dss-item{display:flex;align-items:flex-start;gap:8px;padding:5px 0}',
			'.dss-item-when{flex:none;font-size:12px;color:var(--dsw-alias-brand-primary,#4d6bfe);padding-top:1px}',
			'.dss-item-text{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#8a8f98);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
			'.dss-item-x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer}',
			'.dss-item-x:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328)}',
			'.dss-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
			'.dss-btn{height:34px;padding:0 16px;border-radius:9px;font-size:14px;font-family:inherit;cursor:pointer;border:1px solid transparent}',
			'.dss-btn-ghost{border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.22));background:transparent;color:var(--dsw-alias-label-primary,#1f2328)}',
			'.dss-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}',
			'.dss-btn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}',
			'.dss-btn-primary:hover:not(:disabled){filter:brightness(1.06)}',
			'.dss-btn:disabled{opacity:.6;cursor:default}',
			'@keyframes dss-fade{from{opacity:0}to{opacity:1}}',
			// ── 宿主发送按钮的造型微调（宽屏：拼成一颗胶囊） ──────────────────
			// 三条都只改外观，并且只在「宽屏 且 没有移动端的环占位」时生效：
			//   - 圆角没匹配上 → 接缝处多两个直角，仍是两个蓝按钮挨着；
			//   - 旋转没匹配上 → 发送箭头朝上，其余照旧；
			//   - :has() 没匹配上 → 运行中主按钮变「停止」时，箭头仍然显示着。
			'@media (min-width:768px){[data-composer-card]:not(:has([data-mobile-nav="stats-ring-reserve"])) button[class*="_primary"]{position:relative;border-radius:0 999px 999px 0}}',
			'[data-composer-card] button[class*="_primary"] svg{transform:rotate(90deg)}',
			// 分隔线画在发送按钮自己的左缘上：不管中间到底隔了几像素，它永远正好落在
			// 两半的接缝处。「停止」方块出现时箭头半段会收起，这条线也跟着不画。
			'@media (min-width:768px){[data-composer-card]:not(:has([data-mobile-nav="stats-ring-reserve"])):not(:has(button[class*="_primary"] svg rect)) button[class*="_primary"]:before{content:"";position:absolute;left:0;top:11px;bottom:11px;width:1px;background:rgba(255,255,255,.4)}}',
			// 悬停时整颗胶囊一起变色，而不是只亮一半。
			'@media (min-width:768px){[data-composer-card]:not(:has([data-mobile-nav="stats-ring-reserve"])):has(button[class*="_primary"]:hover) .dss-trigger{background:var(--dsw-alias-button-info-hover,var(--dsw-alias-brand-primary,#4d6bfe))}}',
			'[data-composer-card]:has(button[class*="_primary"] svg rect) .dss-anchor{display:none}',
			// ── 移动端 / 窄屏：退回成「发送键旁边的一个小图标按钮」 ────────────
			// dsh-web-mobile 在窄屏下把 .trailing 的间距从 12px 压到 3px，还会在发送键
			// 左边插一个 18px 的环占位 span（把上下文环搬过去）。这时候再往右贴 24px
			// 既贴不严、又会压住那个环，所以窄屏干脆不拼胶囊。
			'@media (max-width:767px){.dss-anchor{right:0}.dss-trigger{width:28px;height:28px;padding:0;border-radius:8px;transform:none;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98)}.dss-trigger:hover:not([data-dim="1"]){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328)}.dss-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}}',
			// 平板档（≥768px 但 pointer:coarse）web-mobile 也会插占位，同样退回小按钮。
			'[data-composer-card]:has([data-mobile-nav="stats-ring-reserve"]) .dss-anchor{right:0}',
			'[data-composer-card]:has([data-mobile-nav="stats-ring-reserve"]) .dss-trigger{width:28px;height:28px;padding:0;border-radius:8px;transform:none;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98)}',
			'[data-composer-card]:has([data-mobile-nav="stats-ring-reserve"]) .dss-trigger:hover:not([data-dim="1"]){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328)}',
			// 定时对话框：窄屏改成从底部升起的抽屉，输入框用 16px 字号（否则 iOS 聚焦会放大整页）。
			'@media (max-width:560px){.dss-backdrop{align-items:flex-end;padding:0}.dss-card{width:100%;max-height:88vh;padding:16px 16px calc(20px + env(safe-area-inset-bottom,0px));border-radius:16px 16px 0 0;border-bottom:0;border-left:0;border-right:0}.dss-input{height:42px;font-size:16px}.dss-btn{height:40px}.dss-preview{max-height:76px}.dss-item-x{width:26px;height:26px}}',
			'@media (max-width:400px){.dss-fields{grid-template-columns:1fr}}'
		].join('\n');
		// #endregion

		// #region helpers
		/** 两位补零。 */
		function pad2(value) {
			return String(value).padStart(2, '0');
		}

		/** `YYYY-MM-DD`（本地时区）。 */
		function dateValue(date) {
			return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
		}

		/** `HH:mm`（本地时区）。 */
		function timeValue(date) {
			return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
		}

		/**
		 * 把对话框里的两个输入框拼成一个本地时间点。
		 *
		 * @param {string} dateText - `YYYY-MM-DD`。
		 * @param {string} timeText - `HH:mm`。
		 * @returns {Date | null} 合法时返回 Date，否则 null。
		 */
		function parseLocal(dateText, timeText) {
			const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText));
			const clock = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeText));
			if (day === null || clock === null) return null;
			const year = Number(day[1]);
			const month = Number(day[2]) - 1;
			const dayOfMonth = Number(day[3]);
			const when = new Date(year, month, dayOfMonth, Number(clock[1]), Number(clock[2]), clock[3] === undefined ? 0 : Number(clock[3]), 0);
			if (Number.isNaN(when.getTime())) return null;
			if (when.getFullYear() !== year || when.getMonth() !== month || when.getDate() !== dayOfMonth) return null;
			return when;
		}

		/**
		 * 打开对话框时的默认时间：下一个 30 分钟刻度，且至少 5 分钟后。
		 *
		 * 12:28 打开 → 13:00（和飞书那张截图一致）。
		 *
		 * @returns {Date} 默认时间。
		 */
		function defaultWhen() {
			const step = 30 * 60 * 1000;
			const edge = Date.now() + 5 * 60 * 1000;
			return new Date(Math.ceil(edge / step) * step);
		}

		/**
		 * 把时间点写成人话。
		 *
		 * @param {number} ms - epoch ms。
		 * @returns {string} 「今天 13:00」「明天 9:00」「11月2日 13:00」。
		 */
		function formatWhen(ms) {
			const when = new Date(ms);
			const now = new Date();
			const clock = timeValue(when);
			if (when.toDateString() === now.toDateString()) return t('today') + ' ' + clock;
			const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
			if (when.toDateString() === tomorrow.toDateString()) return t('tomorrow') + ' ' + clock;
			let locale = 'zh-CN';
			try {
				locale = Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN';
			} catch {
				locale = 'zh-CN';
			}
			try {
				const day = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(when);
				return day + ' ' + clock;
			} catch {
				return (when.getMonth() + 1) + '/' + when.getDate() + ' ' + clock;
			}
		}

		/** 浏览器时区（不合法就不带）。 */
		function detectTimeZone() {
			try {
				const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
				return typeof zone === 'string' && zone !== '' ? zone : undefined;
			} catch {
				return undefined;
			}
		}

		/** 宿主错误码 → 本地文案。 */
		const ERROR_KEYS = {
			EMPTY: 'errEmpty',
			TOO_LONG: 'errTooLong',
			BAD_SESSION: 'errSession',
			BAD_TIME: 'errTime',
			NOT_FUTURE: 'errPast',
			TOO_FAR: 'errTooFar',
			BAD_TZ: 'errTimeZone',
			BAD_BODY: 'errServer',
			UNKNOWN: 'errServer',
			INTERNAL: 'errServer',
			NOT_FOUND: 'errServer'
		};

		/**
		 * 把宿主返回的失败翻成一句人话。
		 *
		 * @param {any} data - 响应体。
		 * @returns {string} 文案。
		 */
		function reasonOf(data) {
			const code = data !== null && typeof data === 'object' && typeof data.code === 'string' ? data.code : '';
			if (code === 'TOO_LONG') return t('errTooLong', { limit: MAX_TEXT_CHARS });
			const key = ERROR_KEYS[code];
			if (key !== undefined) return t(key);
			const message = data !== null && typeof data === 'object' && typeof data.message === 'string' ? data.message : '';
			return message !== '' ? message : t('errServer');
		}

		/**
		 * 调一次宿主路由。
		 *
		 * @param {string} action - `list` / `create` / `cancel`。
		 * @param {Record<string, unknown>} body - 请求体。
		 * @returns {Promise<any>} 响应体。
		 */
		async function callHost(action, body) {
			const response = await fetch(API + '/' + action, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(body)
			});
			const data = await response.json();
			if (data === null || typeof data !== 'object') throw new Error('empty response');
			return data;
		}

		/** 箭头图标。 */
		function ChevronIcon() {
			return h('svg', {
				width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false'
			}, h('path', {
				d: 'M3.8 6.2 8 10.4l4.2-4.2',
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
				strokeLinecap: 'round', strokeLinejoin: 'round'
			}));
		}

		/** 关闭图标。 */
		function CloseIcon() {
			return h('svg', {
				width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false'
			}, h('path', {
				d: 'M4 4l8 8M12 4l-8 8',
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round'
			}));
		}
		// #endregion

		// #region component
		/**
		 * 输入框工具栏里的那个箭头。
		 *
		 * @param {any} props - 槽位属性（sessionId / useInput / inputActions）。
		 * @returns {any} React 元素。
		 */
		function Trigger(props) {
			const sessionId = props.sessionId;
			const inputActions = props.inputActions;
			const useInput = props.useInput;
			const state = typeof useInput === 'function' ? useInput((snapshot) => snapshot) : undefined;
			const draftText = state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : '';
			const attachmentCount = state !== null && state !== undefined && Array.isArray(state.attachmentIds) ? state.attachmentIds.length : 0;

			const [open, setOpen] = React.useState(false);
			const [pending, setPending] = React.useState([]);
			const [snapshot, setSnapshot] = React.useState('');
			const [dateText, setDateText] = React.useState('');
			const [timeText, setTimeText] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState('');
			const [toast, setToast] = React.useState('');
			const alive = React.useRef(true);
			const toastTimer = React.useRef(null);

			/** 拉一次待发送列表（失败就算了，它只是辅助信息）。 */
			const refresh = React.useCallback(async () => {
				if (typeof sessionId !== 'string' || sessionId === '') return;
				try {
					const data = await callHost('list', { sessionId });
					if (alive.current !== true) return;
					setPending(data.ok === true && Array.isArray(data.items) ? data.items : []);
				} catch {
					if (alive.current === true) setPending([]);
				}
			}, [sessionId]);

			React.useEffect(() => {
				alive.current = true;
				void refresh();
				const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
				return () => {
					alive.current = false;
					clearInterval(timer);
					if (toastTimer.current !== null) clearTimeout(toastTimer.current);
				};
			}, [refresh]);

			React.useEffect(() => {
				if (open !== true) return undefined;
				const onKeyDown = (event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						setOpen(false);
					}
				};
				document.addEventListener('keydown', onKeyDown, true);
				return () => document.removeEventListener('keydown', onKeyDown, true);
			}, [open]);

			/** 弹一句「已排到 …」。 */
			const showToast = (text) => {
				setToast(text);
				if (toastTimer.current !== null) clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(() => {
					if (alive.current === true) setToast('');
				}, TOAST_MS);
			};

			/** 打开对话框：此刻的草稿就是这条定时消息的正文。 */
			const openDialog = () => {
				const when = defaultWhen();
				setSnapshot(draftText);
				setDateText(dateValue(when));
				setTimeText(timeValue(when));
				setError('');
				setBusy(false);
				setOpen(true);
				void refresh();
			};

			/**
			 * 预设：往后推 n 分钟（对齐到整分）。
			 *
			 * @param {number} minutes - 往后推多少分钟。
			 */
			const presetAfter = (minutes) => {
				const when = new Date(Date.now() + minutes * 60 * 1000);
				when.setSeconds(0, 0);
				if (when.getTime() <= Date.now() + 1000) when.setMinutes(when.getMinutes() + 1);
				setDateText(dateValue(when));
				setTimeText(timeValue(when));
				setError('');
			};

			/** 预设：明天 9:00。 */
			const presetTomorrow = () => {
				const when = new Date();
				when.setDate(when.getDate() + 1);
				when.setHours(9, 0, 0, 0);
				setDateText(dateValue(when));
				setTimeText(timeValue(when));
				setError('');
			};

			/** 「定时发送」。 */
			const confirm = async () => {
				if (busy === true) return;
				const text = snapshot.trim();
				if (text === '') {
					setError(t('errEmpty'));
					return;
				}
				if (attachmentCount > 0) {
					setError(t('errAttachments'));
					return;
				}
				if (text.length > MAX_TEXT_CHARS) {
					setError(t('errTooLong', { limit: MAX_TEXT_CHARS }));
					return;
				}
				const when = parseLocal(dateText, timeText);
				if (when === null) {
					setError(t('errTime'));
					return;
				}
				const lead = when.getTime() - Date.now();
				if (lead < 1000) {
					setError(t('errPast'));
					return;
				}
				if (lead > MAX_LEAD_MS) {
					setError(t('errTooFar'));
					return;
				}
				setBusy(true);
				setError('');
				try {
					const data = await callHost('create', {
						sessionId,
						text,
						dueAt: when.getTime(),
						timeZone: detectTimeZone()
					});
					if (alive.current !== true) return;
					setBusy(false);
					if (data.ok !== true) {
						setError(reasonOf(data));
						return;
					}
					setOpen(false);
					if (inputActions !== undefined && inputActions !== null && typeof inputActions.setDraft === 'function') {
						inputActions.setDraft('');
					}
					showToast(t('scheduledAt', { when: formatWhen(when.getTime()) }));
					void refresh();
				} catch {
					if (alive.current !== true) return;
					setBusy(false);
					setError(t('errNetwork'));
				}
			};

			/**
			 * 撤销一条待发送。
			 *
			 * @param {string} id - 条目 id。
			 */
			const cancelOne = async (id) => {
				setPending((items) => items.filter((item) => item.id !== id));
				try {
					await callHost('cancel', { id, sessionId });
				} catch {
					/* 下次刷新会把它带回来 */
				}
				void refresh();
			};

			const presets = [
				{ key: 'preset10', run: () => presetAfter(10) },
				{ key: 'preset30', run: () => presetAfter(30) },
				{ key: 'preset60', run: () => presetAfter(60) },
				{ key: 'presetTomorrow', run: presetTomorrow }
			];

			const dialog = open === true
				? ReactDOM.createPortal(
					h('div', {
						className: 'dss-backdrop',
						onMouseDown: (event) => {
							if (event.target === event.currentTarget) setOpen(false);
						}
					},
						h('div', {
							className: 'dss-card',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': t('title')
						},
							h('div', { className: 'dss-head' },
								h('div', { className: 'dss-title' }, t('title')),
								h('button', {
									type: 'button',
									className: 'dss-close',
									'aria-label': t('close'),
									title: t('close'),
									onClick: () => setOpen(false)
								}, h(CloseIcon))
							),
							h('div', {
								className: 'dss-preview' + (snapshot.trim() === '' ? ' dss-preview-empty' : '')
							}, snapshot.trim() === '' ? t('previewEmpty') : snapshot),
							h('div', { className: 'dss-fields' },
								h('label', { className: 'dss-field' },
									h('span', { className: 'dss-label' }, t('date')),
									h('input', {
										className: 'dss-input',
										type: 'date',
										value: dateText,
										autoFocus: true,
										onChange: (event) => { setDateText(event.target.value); setError(''); }
									})
								),
								h('label', { className: 'dss-field' },
									h('span', { className: 'dss-label' }, t('time')),
									h('input', {
										className: 'dss-input',
										type: 'time',
										value: timeText,
										onChange: (event) => { setTimeText(event.target.value); setError(''); }
									})
								)
							),
							h('div', { className: 'dss-presets' },
								presets.map((preset) => h('button', {
									key: preset.key,
									type: 'button',
									className: 'dss-chip',
									onClick: preset.run
								}, t(preset.key)))
							),
							error === '' ? null : h('div', { className: 'dss-error' }, error),
							pending.length === 0 ? null : h('div', { className: 'dss-pending' },
								h('div', { className: 'dss-pending-head' }, t('pendingTitle') + ' · ' + pending.length),
								pending.map((item) => h('div', { key: item.id, className: 'dss-item' },
									h('span', { className: 'dss-item-when' }, formatWhen(Number(item.dueAt))),
									h('span', { className: 'dss-item-text' }, String(item.text)),
									h('button', {
										type: 'button',
										className: 'dss-item-x',
										'aria-label': t('remove'),
										title: t('remove'),
										onClick: () => { void cancelOne(item.id); }
									}, h(CloseIcon))
								))
							),
							h('div', { className: 'dss-actions' },
								h('button', {
									type: 'button',
									className: 'dss-btn dss-btn-ghost',
									onClick: () => setOpen(false)
								}, t('cancel')),
								h('button', {
									type: 'button',
									className: 'dss-btn dss-btn-primary',
									disabled: busy === true,
									onClick: () => { void confirm(); }
								}, busy === true ? t('busy') : t('confirm'))
							)
						)
					),
					document.body
				)
				: null;

			return h(React.Fragment, null,
				h('div', { className: 'dss-anchor' },
					h('button', {
						type: 'button',
						className: 'dss-trigger',
						'data-dim': draftText.trim() === '' && attachmentCount === 0 ? '1' : '0',
						'aria-label': pending.length > 0 ? t('badge', { count: pending.length }) : t('tip'),
						onClick: openDialog
					},
						h(ChevronIcon),
						pending.length > 0 ? h('span', { className: 'dss-dot' }) : null
					),
					h('span', { className: 'dss-tip', role: 'tooltip' },
						pending.length > 0 ? t('badge', { count: pending.length }) : t('tip')
					),
					toast === '' ? null : h('span', { className: 'dss-toast', role: 'status' }, toast)
				),
				dialog
			);
		}
		// #endregion

		const inject = ['slots', 'locale'];

		/**
		 * 挂载客户端。
		 *
		 * @param {any} ctx - 客户端上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => {
				if (typeof document === 'undefined') return undefined;
				document.querySelectorAll('style[data-plugin="' + NS + '/composer"]').forEach((node) => node.remove());
				const style = document.createElement('style');
				style.dataset.plugin = NS + '/composer';
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, 'dsh-scheduled-send: styles');

			if (ctx.locale !== undefined && ctx.locale !== null) {
				try {
					const active = typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : undefined;
					const id = active !== null && active !== undefined && typeof active.id === 'string' ? active.id : '';
					if (/^zh/i.test(id)) fallbackLang = 'zh';
					else if (/^en/i.test(id)) fallbackLang = 'en';
				} catch {
					/* 用 navigator 猜的 */
				}

				ctx.effect(() => {
					let offZh;
					let offEn;
					try {
						offZh = ctx.locale.register(NS, 'zh', zh);
						offEn = ctx.locale.register(NS, 'en', en);
					} catch (error) {
						console.error('[dsh-scheduled-send] locale register failed', error);
						return undefined;
					}
					try {
						bound = ctx.locale.bind(NS);
					} catch {
						bound = null;
					}
					return () => {
						if (typeof offZh === 'function') offZh();
						if (typeof offEn === 'function') offEn();
					};
				}, 'dsh-scheduled-send: dictionaries');
			}

			if (ctx.slots === undefined || ctx.slots === null) {
				console.error('[dsh-scheduled-send] no slots service; the composer trigger is not registered');
				return;
			}

			ctx.effect(() => {
				try {
					return ctx.slots.inject('conversation.input.right', function* () {
						yield ctx.slots.register({
							name: 'conversation.input.right',
							id: 'dsh-scheduled-send-trigger',
							order: 90,
							locale: NS
						}, function (slotProps) {
							return h(Trigger, Object.assign({}, slotProps));
						});
					});
				} catch (error) {
					console.error('[dsh-scheduled-send] composer trigger registration failed', error);
					return () => {};
				}
			}, 'dsh-scheduled-send: composer trigger');
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

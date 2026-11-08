// ==UserScript==
// @name         知到（智慧树）静态站桥接
// @namespace    hust-course-hack
// @version      1.0.0
// @description  在知到页面使用现有登录态，为你明确连接的课程助手静态站转发知到接口请求
// @match        https://onlineweb.zhihuishu.com/onlinestuh5*
// @match        https://online.zhihuishu.com/*
// @match        https://studyvideoh5.zhihuishu.com/*
// @match        https://stuonline.zhihuishu.com/*
// @match        https://lc.zhihuishu.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==
(function() {
	// src/core/zhs/transport.ts
	var ZHS_CHANNEL = "zhs-bridge-v1";
	var ZHS_PAGE_ORIGINS = [
		"https://onlineweb.zhihuishu.com",
		"https://online.zhihuishu.com",
		"https://studyvideoh5.zhihuishu.com",
		"https://stuonline.zhihuishu.com",
		"https://lc.zhihuishu.com"
	];
	var ZHS_STUDYSERVICE_ORIGIN = "https://studyservice-api.zhihuishu.com";
	var ZHS_ONLINESERVICE_ORIGIN = "https://onlineservice-api.zhihuishu.com";
	var ZHS_APPLIVE_ORIGIN = "https://appcomm-live-api.zhihuishu.com";
	var ROUTES = [
		{
			origin: ZHS_STUDYSERVICE_ORIGIN,
			method: "POST",
			path: /^\/gateway\/t\/v1\/learning\/(queryCourse|videolist|prelearningNote|queryStuyInfo|saveDatabaseIntervalTimeV2)$/
		},
		{
			origin: ZHS_STUDYSERVICE_ORIGIN,
			method: "GET",
			path: /^\/gateway\/t\/v1\/login\/getLoginUserInfo$/
		},
		{
			origin: ZHS_STUDYSERVICE_ORIGIN,
			method: "GET",
			path: /^\/gateway\/t\/v1\/cheat\/exceptionActionDetail$/
		},
		{
			origin: ZHS_ONLINESERVICE_ORIGIN,
			method: "POST",
			path: /^\/gateway\/t\/v1\/student\/course\/share\/queryShareCourseInfo$/
		},
		{
			origin: "https://appcomm-user.zhihuishu.com",
			method: "GET",
			path: /^\/app-commserv-user\/c\/has$/
		},
		{
			origin: ZHS_APPLIVE_ORIGIN,
			method: "GET",
			path: /^\/app-commserv-live\/gateway\/t\/v1\/pc\/live\/(getWatchHistory|setWatchHistorySecret)$/
		},
		{
			origin: ZHS_APPLIVE_ORIGIN,
			method: "GET",
			path: /^\/app-commserv-live\/gateway\/t\/v1\/chect\/exceptionActionDetail$/
		},
		{
			origin: "https://online.zhihuishu.com",
			method: "POST",
			path: /^\/onlineSchool\/json\/teachMeeting\/listTeachMeetingStu$/
		},
		{
			origin: "https://stuonline.zhihuishu.com",
			method: "POST",
			path: /^\/stuonline\/teachMeeting\/listTeachMeetingStu$/
		},
		{
			origin: "https://im.zhihuishu.com",
			method: "GET",
			path: /^\/livehome\/getVideosByLiveId$/
		}
	];
	var MAX_BODY_BYTES = 2e5;
	/** The popup only forwards these Zhihuishu API endpoints. */
	function allowedZhsRequest(input) {
		try {
			if (typeof input.url !== "string") return false;
			const url = new URL(input.url);
			if (url.username || url.password) return false;
			if (url.protocol !== "https:" && url.protocol !== "http:") return false;
			const method = input.method ?? "GET";
			if (method !== "GET" && method !== "POST") return false;
			if (method === "GET" && input.body !== void 0) return false;
			if (method === "POST" && typeof input.body !== "string") return false;
			if (typeof input.body === "string" && input.body.length > MAX_BODY_BYTES) return false;
			return ROUTES.some((route) => route.origin === url.origin && route.method === method && route.path.test(url.pathname));
		} catch {
			return false;
		}
	}
	/** Trusted static-site origin for the handshake (https, or local development). */
	function trustedSiteOrigin(value) {
		try {
			const url = new URL(value);
			return url.origin === value && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
		} catch {
			return false;
		}
	}
	// src/zhs-bridge.user.ts
	if (ZHS_PAGE_ORIGINS.includes(location.origin) && window.top === window && window.opener) {
		let origin = "";
		let nonce = "";
		let rejected = false;
		let lastReady = 0;
		const active = {};
		let activeCount = 0;
		/** Read the non-HttpOnly `CASLOGC` cookie the platform itself parses. */
		const readIdentity = () => {
			const match = document.cookie.match(/(?:^|;\s*)CASLOGC=([^;]+)/);
			if (!match) return null;
			try {
				const value = JSON.parse(decodeURIComponent(match[1]));
				if (typeof value.uuid !== "string" || !value.uuid) return null;
				const userId = Number(value.userId);
				return {
					uuid: value.uuid,
					userId: Number.isFinite(userId) && userId > 0 ? userId : null
				};
			} catch {
				return null;
			}
		};
		window.addEventListener("message", async (event) => {
			const data = event.data;
			if (!data || data.channel !== "zhs-bridge-v1") return;
			if (event.source !== window.opener) return;
			if (data.type === "zhs-hello") {
				if (rejected || typeof data.nonce !== "string" || data.nonce.length > 100 || !trustedSiteOrigin(event.origin)) return;
				if (!origin) {
					if (!confirm(`允许课程助手 ${event.origin} 通过此窗口读取知到课程并执行你在助手中选择的任务？\n\nCookie 不会发送给助手。关闭此窗口可断开连接。`)) {
						rejected = true;
						return;
					}
					origin = event.origin;
					nonce = data.nonce;
				}
				if (origin !== event.origin || nonce !== data.nonce) return;
				const identity = readIdentity();
				if (!identity) return;
				if (Date.now() - lastReady < 1500) return;
				lastReady = Date.now();
				window.opener?.postMessage({
					channel: ZHS_CHANNEL,
					type: "zhs-ready",
					nonce,
					platform: "zhihuishu",
					uuid: identity.uuid,
					userId: identity.userId ?? void 0
				}, origin);
				return;
			}
			if (!origin || event.origin !== origin || data.nonce !== nonce) return;
			if (data.type === "zhs-disconnect") {
				for (const controller of Object.values(active)) controller.abort();
				for (const key of Object.keys(active)) delete active[key];
				activeCount = 0;
				origin = "";
				nonce = "";
				return;
			}
			if (data.type === "zhs-abort") {
				if (typeof data.id === "string") active[data.id]?.abort();
				return;
			}
			if (data.type !== "zhs-request" || typeof data.id !== "string" || data.id in active) return;
			const input = {
				url: typeof data.url === "string" ? data.url : "",
				method: data.method === "POST" ? "POST" : "GET",
				body: typeof data.body === "string" ? data.body : void 0
			};
			const reply = (payload) => window.opener?.postMessage({
				channel: ZHS_CHANNEL,
				type: "zhs-response",
				nonce,
				id: data.id,
				...payload
			}, origin);
			if (!allowedZhsRequest(input)) {
				reply({ error: "桥接拒绝了非知到接口请求" });
				return;
			}
			if (activeCount >= 8) {
				reply({ error: "并发请求过多" });
				return;
			}
			const controller = new AbortController();
			active[data.id] = controller;
			activeCount += 1;
			const timeout = setTimeout(() => controller.abort(), 4e4);
			try {
				const response = await fetch(input.url, {
					method: input.method ?? "GET",
					body: input.method === "POST" ? input.body : void 0,
					credentials: "include",
					mode: "cors",
					redirect: "follow",
					headers: input.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : void 0,
					signal: controller.signal
				});
				reply({
					status: response.status,
					text: await response.text()
				});
			} catch {
				reply({ error: "知到请求失败或已取消，请检查此窗口的登录状态。" });
			} finally {
				clearTimeout(timeout);
				delete active[data.id];
				activeCount -= 1;
			}
		});
	}
})();

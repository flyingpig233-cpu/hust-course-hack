// ==UserScript==
// @name         优学院静态站桥接
// @namespace    hust-course-hack
// @version      1.0.0
// @description  在优学院页面使用现有登录态，为你明确连接的课程助手静态站转发优学院接口请求
// @match        https://courseweb.ulearning.cn/*
// @match        https://ua.ulearning.cn/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==
(function() {
	// src/core/ul/transport.ts
	var UL_CHANNEL = "ul-bridge-v1";
	var UL_PAGE_ORIGINS = ["https://courseweb.ulearning.cn", "https://ua.ulearning.cn"];
	var UL_API_ORIGIN = "https://api.ulearning.cn";
	var UL_COURSEAPI_ORIGIN = "https://courseapi.ulearning.cn";
	var ROUTES = [
		{
			origin: UL_API_ORIGIN,
			method: "GET",
			path: /^\/user$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "GET",
			path: /^\/course\/\d+\/(remaining|basicinformation)$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "GET",
			path: /^\/classes\/\d+$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "GET",
			path: /^\/course\/stu\/\d+\/directory$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "GET",
			path: /^\/wholepage\/(chapter|item)\/stu\/\d+$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "GET",
			path: /^\/wholepage\/stu\/\d+$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "GET",
			path: /^\/studyrecord\/(initialize|item)\/\d+$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "GET",
			path: /^\/questionAnswer\/\d+$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "POST",
			path: /^\/yws\/api\/personal\/sync$/
		},
		{
			origin: UL_API_ORIGIN,
			method: "POST",
			path: /^\/user\/currentUnit$/
		},
		{
			origin: UL_COURSEAPI_ORIGIN,
			method: "GET",
			path: /^\/courses\/students$/
		},
		{
			origin: UL_COURSEAPI_ORIGIN,
			method: "GET",
			path: /^\/textbook\/student\/\d+\/list$/
		}
	];
	var MAX_BODY_BYTES = 2e5;
	/** Only these Ulearning API endpoints may be called through the popup. */
	function allowedUlRequest(input) {
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
	function trustedUlSiteOrigin(value) {
		try {
			const url = new URL(value);
			return url.origin === value && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
		} catch {
			return false;
		}
	}
	// src/ul-bridge.user.ts
	if (UL_PAGE_ORIGINS.includes(location.origin) && window.top === window && window.opener) {
		let origin = "";
		let nonce = "";
		let rejected = false;
		let lastReady = 0;
		const active = {};
		let activeCount = 0;
		/** Read the platform's own `AUTHORIZATION` cookie (non-HttpOnly by design). */
		const readToken = () => {
			const match = document.cookie.match(/(?:^|;\s*)AUTHORIZATION=([^;]+)/);
			if (!match) return "";
			try {
				return decodeURIComponent(match[1]).trim();
			} catch {
				return "";
			}
		};
		window.addEventListener("message", async (event) => {
			const data = event.data;
			if (!data || data.channel !== "ul-bridge-v1") return;
			if (event.source !== window.opener) return;
			if (data.type === "ul-hello") {
				if (rejected || typeof data.nonce !== "string" || data.nonce.length > 100 || !trustedUlSiteOrigin(event.origin)) return;
				if (!origin) {
					if (!confirm(`允许课程助手 ${event.origin} 通过此窗口读取优学院课程并执行你在助手中选择的任务？\n\n登录 token 只在优学院页面内使用，不会发送给助手。关闭此窗口可断开连接。`)) {
						rejected = true;
						return;
					}
					origin = event.origin;
					nonce = data.nonce;
				}
				if (origin !== event.origin || nonce !== data.nonce) return;
				if (!readToken()) return;
				if (Date.now() - lastReady < 1500) return;
				lastReady = Date.now();
				window.opener?.postMessage({
					channel: UL_CHANNEL,
					type: "ul-ready",
					nonce,
					platform: "ulearning"
				}, origin);
				return;
			}
			if (!origin || event.origin !== origin || data.nonce !== nonce) return;
			if (data.type === "ul-disconnect") {
				for (const controller of Object.values(active)) controller.abort();
				for (const key of Object.keys(active)) delete active[key];
				activeCount = 0;
				origin = "";
				nonce = "";
				return;
			}
			if (data.type === "ul-abort") {
				if (typeof data.id === "string") active[data.id]?.abort();
				return;
			}
			if (data.type !== "ul-request" || typeof data.id !== "string" || data.id in active) return;
			const input = {
				url: typeof data.url === "string" ? data.url : "",
				method: data.method === "POST" ? "POST" : "GET",
				body: typeof data.body === "string" ? data.body : void 0
			};
			const reply = (payload) => window.opener?.postMessage({
				channel: UL_CHANNEL,
				type: "ul-response",
				nonce,
				id: data.id,
				...payload
			}, origin);
			if (!allowedUlRequest(input)) {
				reply({ error: "桥接拒绝了非优学院接口请求" });
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
				const target = new URL(input.url);
				const headers = {};
				if (target.origin === "https://api.ulearning.cn" || target.origin === "https://courseapi.ulearning.cn") {
					const token = readToken();
					if (!token) throw new Error("missing authorization cookie");
					headers.Authorization = token;
					headers["UA-AUTHORIZATION"] = token;
					headers.version = "1";
				}
				if (input.method === "POST") headers["Content-Type"] = "application/json;charset=UTF-8";
				if (target.origin === "https://courseapi.ulearning.cn") {
					headers["Content-Type"] = "application/json";
					headers.Accept = "application/json, text/javascript, */*; q=0.01";
				}
				const response = await fetch(input.url, {
					method: input.method ?? "GET",
					body: input.method === "POST" ? input.body : void 0,
					credentials: "include",
					mode: "cors",
					redirect: "follow",
					headers,
					signal: controller.signal
				});
				reply({
					status: response.status,
					text: await response.text()
				});
			} catch {
				reply({ error: "优学院请求失败或已取消，请检查此窗口的登录状态。" });
			} finally {
				clearTimeout(timeout);
				delete active[data.id];
				activeCount -= 1;
			}
		});
	}
})();

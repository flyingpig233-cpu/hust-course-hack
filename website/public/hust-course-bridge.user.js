// ==UserScript==
// @name         HUST Course 静态站桥接
// @namespace    hust-course-hack
// @version      1.0.0
// @description  在学校页面使用现有登录态，为你明确连接的课程助手静态站转发请求
// @match        https://smartcourse.hust.edu.cn/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==
(function() {
	// src/core/transport.ts
	var PLATFORM = "https://smartcourse.hust.edu.cn";
	var CHANNEL = "hust-course-bridge-v1";
	/** Both ends enforce this list. The bridge cannot act as a general-purpose proxy. */
	function allowedRequest(input) {
		try {
			const url = new URL(input.url);
			if (url.origin !== "https://smartcourse.hust.edu.cn" || url.username || url.password) return false;
			if (input.referrer && new URL(input.referrer).origin !== "https://smartcourse.hust.edu.cn") return false;
			if (input.method === "POST") return url.pathname === "/mooc-ans/work/addStudentWorkNewWeb";
			if (input.method && input.method !== "GET") return false;
			return [
				"/fyportal-smartcourse/fyportal/wfw/courselist/getStudyCourse",
				"/fyportal-smartcourse/courselist/opencoursenewfy",
				"/mooc-ans/mycourse/studentstudycourselist",
				"/mooc-ans/mycourse/studentstudyAjax",
				"/mooc-ans/knowledge/cards",
				"/mooc-ans/api/work",
				"/mooc-ans/work/validate"
			].includes(url.pathname) || /^\/ananas\/status\/[\w-]+$/.test(url.pathname) || /^\/mooc-ans\/multimedia\/log\/a\/[\w-]+\/[\w.-]+$/.test(url.pathname);
		} catch {
			return false;
		}
	}
	// src/bridge.user.ts
	if (window.top === window && location.origin === "https://smartcourse.hust.edu.cn" && window.opener) {
		let origin = "";
		let nonce = "";
		let rejected = false;
		let checking = false;
		let verifiedAt = 0;
		const active = /* @__PURE__ */ new Map();
		const trustedOrigin = (value) => {
			try {
				const url = new URL(value);
				return url.origin === value && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
			} catch {
				return false;
			}
		};
		window.addEventListener("message", async (event) => {
			const data = event.data;
			if (event.source !== window.opener || data?.channel !== "hust-course-bridge-v1") return;
			if (data.type === "hello") {
				if (rejected || typeof data.nonce !== "string" || data.nonce.length > 100 || !trustedOrigin(event.origin)) return;
				if (!origin) {
					if (!confirm(`允许课程助手 ${event.origin} 通过此窗口读取课程并执行你在助手中选择的任务？\n\nCookie 不会发送给助手。关闭此窗口可断开连接。`)) {
						rejected = true;
						return;
					}
					origin = event.origin;
					nonce = data.nonce;
				}
				if (origin !== event.origin || nonce !== data.nonce || checking) return;
				if (Date.now() - verifiedAt < 2e3) return;
				checking = true;
				verifiedAt = Date.now();
				try {
					const response = await fetch(`${PLATFORM}/fyportal-smartcourse/fyportal/wfw/courselist/getStudyCourse?sectionId=0`, {
						credentials: "same-origin",
						mode: "same-origin",
						signal: AbortSignal.timeout(8e3)
					});
					const body = await response.text();
					if (response.ok && new URL(response.url).pathname.endsWith("/getStudyCourse") && !/请先登录|用户登录|<title>[^<]*登录/.test(body) && (body.includes("w_couritem") || !/passport|\blogin\b/i.test(body))) window.opener.postMessage({
						channel: CHANNEL,
						type: "ready",
						nonce
					}, origin);
				} catch {} finally {
					checking = false;
				}
				return;
			}
			if (!origin || event.origin !== origin || data.nonce !== nonce) return;
			if (data.type === "disconnect") {
				active.forEach((controller) => controller.abort());
				active.clear();
				origin = "";
				nonce = "";
				return;
			}
			if (data.type === "abort") {
				active.get(data.id)?.abort();
				return;
			}
			if (data.type !== "request" || typeof data.id !== "string" || !data.input || active.has(data.id)) return;
			const input = data.input;
			const reply = (payload) => window.opener?.postMessage({
				channel: CHANNEL,
				type: "response",
				nonce,
				id: data.id,
				...payload
			}, origin);
			if (!allowedRequest(input)) {
				reply({ error: "桥接拒绝了非课程接口请求" });
				return;
			}
			if (active.size >= 12) {
				reply({ error: "并发请求过多" });
				return;
			}
			const controller = new AbortController();
			active.set(data.id, controller);
			const timeout = setTimeout(() => controller.abort(), 4e4);
			try {
				const response = await fetch(input.url, {
					method: input.method ?? "GET",
					body: input.body,
					credentials: "same-origin",
					mode: "same-origin",
					redirect: "follow",
					referrer: input.referrer ?? `https://smartcourse.hust.edu.cn/i-smartcourse/base`,
					referrerPolicy: "same-origin",
					headers: input.method === "POST" ? {
						"Content-Type": "application/x-www-form-urlencoded",
						"X-Requested-With": "XMLHttpRequest"
					} : { "X-Requested-With": "XMLHttpRequest" },
					signal: controller.signal
				});
				if (new URL(response.url).origin !== "https://smartcourse.hust.edu.cn") throw new Error("请在学校窗口完成登录");
				reply({ response: {
					body: await response.text(),
					url: response.url,
					status: response.status
				} });
			} catch {
				reply({ error: "学校请求失败或已取消，请检查此窗口的登录状态。" });
			} finally {
				clearTimeout(timeout);
				active.delete(data.id);
			}
		});
	}
})();

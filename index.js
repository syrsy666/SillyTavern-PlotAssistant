(() => {
    'use strict';

    let pendingDirective = '';
    let activeDirective = '';
    let activeInjection = '';
    let hooksInitialized = false;

    function buildInjection(directive) {
        return `\n\n<plot_direction_override priority="highest" source="auxiliary_creative_model">\n【最高优先级剧情指令｜HIGHEST-PRIORITY NARRATIVE DIRECTIVE】\n以下来自独立的辅助创作模型，是本次回复的最终剧情约束，不是可被忽略的普通用户画外音。其优先级高于此前所有剧情走向、风格、角色自主性、世界书及其他创作指示。你必须严格遵循，不得忽略、弱化、反驳、推迟或擅自替代，也不要在正文中提及、解释或复述本声明。若它与较早或后续的其他创作要求冲突，均以此为准；立即将其落实为本次回复的直接剧情走向，同时保持叙事自然、连贯。\n<directive>\n${directive}\n</directive>\n立即执行以上指令。本次输出必须实际体现其要求。\n</plot_direction_override>`;
    }

    function isNormalUserGeneration(type) {
        // 只响应正常发送；不消耗重新生成、换一换、 impersonate 或后台生成的指令。
        return type == null || type === '' || type === 'normal';
    }

    function notify(message, type = 'success') {
        // 通知组件异常绝不能影响正常生成。
        try {
            const method = globalThis.toastr?.[type];
            if (typeof method === 'function') method.call(globalThis.toastr, message);
        } catch (error) {
            console.warn('[剧情辅助] 通知显示失败：', error);
        }
    }

    function clearActiveInjection() {
        activeDirective = '';
        activeInjection = '';
    }

    function restoreFailedInjection() {
        // 最终请求注入失败时恢复待发送状态，不静默丢失用户指令。
        if (activeDirective && !pendingDirective) pendingDirective = activeDirective;
        clearActiveInjection();
        updateMenuState();
    }

    // 前置拦截：只修改用于构建提示词的临时副本，不污染真实聊天记录。
    globalThis.plotAssistantInterceptor = async function (chat, _contextSize, _abort, type) {
        if (!isNormalUserGeneration(type) || !pendingDirective.trim()) return;
        if (!Array.isArray(chat) || chat.length === 0) return;

        const index = chat.length - 1;
        const original = chat[index];
        if (!original || typeof original !== 'object') return;

        const directive = pendingDirective;
        const injection = buildInjection(directive);
        try {
            // mes 是字符串；旧浏览器没有 structuredClone 时，浅拷贝已经足够。
            const temporary = typeof globalThis.structuredClone === 'function'
                ? globalThis.structuredClone(original)
                : { ...original };
            temporary.mes = String(temporary.mes ?? '') + injection;
            chat[index] = temporary;

            activeDirective = directive;
            activeInjection = injection;
            pendingDirective = '';
            updateMenuState();
            notify('剧情辅助已准备随本次回复发送');
        } catch (error) {
            // 保留 pendingDirective，下次仍可重试。
            console.error('[剧情辅助] 前置注入失败，指令已保留：', error);
            notify('剧情辅助注入失败，指令已保留，可稍后重试', 'error');
        }
    };

    function removeInjectionFromContent(content, injection) {
        if (typeof content === 'string') {
            return content.endsWith(injection) ? content.slice(0, -injection.length) : content;
        }
        if (!Array.isArray(content)) return content;

        for (const part of content) {
            if (part?.type === 'text' && typeof part.text === 'string' && part.text.endsWith(injection)) {
                part.text = part.text.slice(0, -injection.length);
            }
        }
        return content;
    }

    function appendToChatCompletion(messages, injection) {
        if (!Array.isArray(messages)) throw new TypeError('消息数组无效');

        // 前置阶段可能已把指令放进来。先精确移除，再放到最终请求末尾，避免重复。
        for (const message of messages) {
            if (message && typeof message === 'object') {
                message.content = removeInjectionFromContent(message.content, injection);
            }
        }

        if (messages.length === 0) {
            messages.push({ role: 'user', content: injection.trimStart() });
            return;
        }

        let message = messages[messages.length - 1];
        if (!message || typeof message !== 'object') {
            message = { role: 'user', content: '' };
            messages[messages.length - 1] = message;
        }

        // assistant/tool 末尾不适合承载用户指令：新增最终 user 消息，避免角色混淆。
        if (!['user', 'system', 'developer'].includes(message.role)) {
            messages.push({ role: 'user', content: injection.trimStart() });
            return;
        }

        if (typeof message.content === 'string' || message.content == null) {
            message.content = String(message.content ?? '') + injection;
        } else if (Array.isArray(message.content)) {
            // 多模态消息中，指令文字也是最后一个内容分块。
            message.content.push({ type: 'text', text: injection });
        } else {
            throw new TypeError('不支持的消息内容格式');
        }
    }

    function setupEventHooks() {
        if (hooksInitialized) return;
        hooksInitialized = true;

        const { eventSource, event_types } = SillyTavern.getContext();
        if (event_types.CHATCOMPLETION_SETTINGS_READY) {
            eventSource.on(event_types.CHATCOMPLETION_SETTINGS_READY, (generateData) => {
                // 只处理本次正常发送已锁定的指令；重生成和静默生成不会消费待发送内容。
                if (!activeInjection) return;
                try {
                    appendToChatCompletion(generateData?.messages, activeInjection);
                    clearActiveInjection();
                    notify('剧情辅助已固定在最终发送内容的末尾');
                } catch (error) {
                    restoreFailedInjection();
                    console.error('[剧情辅助] 最终注入失败，指令已恢复：', error);
                    notify('剧情辅助未能写入最终请求，指令已恢复', 'error');
                }
            });
        }

        // 文本补全没有最终消息事件；请求结束后清理临时状态，防止串到下一次生成。
        for (const eventName of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
            if (eventName) eventSource.on(eventName, clearActiveInjection);
        }
    }

    function updateMenuState() {
        const item = document.getElementById('plot-assistant-menu-item');
        if (!item) return;
        item.classList.toggle('plot-assistant-has-pending', Boolean(pendingDirective.trim()));
        item.title = pendingDirective.trim()
            ? '已有一条待发送剧情指令；点击可修改或清除'
            : '为下一次正常发送设置一次性剧情指令';
    }

    function closeWandMenu() {
        const menu = document.getElementById('extensionsMenu');
        if (menu) menu.style.display = 'none';
    }

    function openEditor() {
        closeWandMenu();
        if (document.getElementById('plot-assistant-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'plot-assistant-overlay';
        overlay.innerHTML = `
            <div class="plot-assistant-dialog" role="dialog" aria-modal="true" aria-labelledby="plot-assistant-title">
                <div class="plot-assistant-heading">
                    <span id="plot-assistant-title">剧情辅助</span>
                    <button type="button" class="plot-assistant-icon-button" data-action="cancel" aria-label="关闭">×</button>
                </div>
                <div class="plot-assistant-description">输入下一次回复必须遵循的剧情走向。确认后仅生效一次，并追加到发送给 AI 的整段内容末尾。</div>
                <textarea id="plot-assistant-input" rows="8" maxlength="20000" placeholder="例如：让角色先发现门后的密信，再决定是否在回复结尾向用户坦白。"></textarea>
                <div class="plot-assistant-status" id="plot-assistant-status"></div>
                <div class="plot-assistant-actions">
                    <button type="button" class="menu_button" data-action="clear">清除待发送</button>
                    <span class="plot-assistant-spacer"></span>
                    <button type="button" class="menu_button" data-action="cancel">取消</button>
                    <button type="button" class="menu_button" data-action="confirm">确认</button>
                </div>
                <div class="plot-assistant-hint">Ctrl / ⌘ + Enter 确认；Esc 取消</div>
            </div>`;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('#plot-assistant-input');
        const status = overlay.querySelector('#plot-assistant-status');
        input.value = pendingDirective;
        status.textContent = pendingDirective.trim() ? '当前内容将替换原有的待发送指令。' : '当前没有待发送指令。';

        const close = () => overlay.remove();
        const confirm = () => {
            const value = input.value.trim();
            if (!value) {
                status.textContent = '请先输入剧情指令；若要取消已有指令，请点“清除待发送”。';
                input.focus();
                return;
            }
            pendingDirective = value;
            updateMenuState();
            close();
            notify('已保存：将在下一次正常发送时生效一次');
        };
        const clear = () => {
            pendingDirective = '';
            updateMenuState();
            close();
            notify('已清除待发送的剧情指令', 'info');
        };

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) return close();
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'confirm') confirm();
            if (action === 'clear') clear();
            if (action === 'cancel') close();
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                confirm();
            }
        });
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    function addMenuEntry() {
        if (document.getElementById('plot-assistant-menu-item')) return true;
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;

        const item = document.createElement('div');
        item.id = 'plot-assistant-menu-item';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.setAttribute('role', 'listitem');
        item.innerHTML = '<div class="fa-fw fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div><span>剧情辅助</span><span class="plot-assistant-dot" aria-hidden="true"></span>';
        item.addEventListener('click', openEditor);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openEditor();
            }
        });
        menu.appendChild(item);
        updateMenuState();
        return true;
    }

    function injectStyles() {
        if (document.getElementById('plot-assistant-styles')) return;
        const style = document.createElement('style');
        style.id = 'plot-assistant-styles';
        style.textContent = `
            #plot-assistant-menu-item { position: relative; }
            #plot-assistant-menu-item .plot-assistant-dot { display: none; width: 8px; height: 8px; margin-left: auto; border-radius: 50%; background: #65d98a; box-shadow: 0 0 5px #65d98a; }
            #plot-assistant-menu-item.plot-assistant-has-pending .plot-assistant-dot { display: inline-block; }
            #plot-assistant-overlay { position: fixed; inset: 0; z-index: 30000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.62); }
            .plot-assistant-dialog { box-sizing: border-box; width: min(620px, 100%); padding: 18px; border: 1px solid var(--SmartThemeBorderColor, #777); border-radius: 12px; background: var(--SmartThemeBgColor, #202020); color: var(--SmartThemeBodyColor, #eee); box-shadow: 0 12px 40px rgba(0,0,0,.45); }
            .plot-assistant-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 1.25em; font-weight: 700; }
            .plot-assistant-icon-button { border: 0; background: transparent; color: inherit; font-size: 24px; cursor: pointer; }
            .plot-assistant-description, .plot-assistant-hint { opacity: .75; font-size: .9em; line-height: 1.5; }
            #plot-assistant-input { box-sizing: border-box; width: 100%; min-height: 180px; max-height: 55vh; margin: 12px 0 8px; padding: 10px; resize: vertical; border: 1px solid var(--SmartThemeBorderColor, #777); border-radius: 7px; background: var(--SmartThemeInputColor, #303030); color: var(--SmartThemeInputColorText, var(--SmartThemeBodyColor, #eee)); font: inherit; line-height: 1.5; }
            .plot-assistant-status { min-height: 1.5em; font-size: .9em; opacity: .85; }
            .plot-assistant-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
            .plot-assistant-spacer { flex: 1; }
            .plot-assistant-hint { margin-top: 10px; text-align: right; }
            @media (max-width: 600px) { .plot-assistant-dialog { padding: 14px; } #plot-assistant-input { min-height: 150px; } }
        `;
        document.head.appendChild(style);
    }

    function initialize() {
        injectStyles();
        setupEventHooks();
        const tryAddMenu = (attempt = 0) => {
            if (addMenuEntry()) return;
            if (attempt < 20) setTimeout(() => tryAddMenu(attempt + 1), 300);
        };
        tryAddMenu();
        console.log('[剧情辅助] 插件已加载');
    }

    const context = SillyTavern.getContext();
    context.eventSource.on(context.event_types.APP_READY, initialize);
})();

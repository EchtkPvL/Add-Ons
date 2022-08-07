'use strict';

const {createElement} = FrankerFaceZ.utilities.dom;
const {has, deep_copy} = FrankerFaceZ.utilities.object;
const {createTester} = FrankerFaceZ.utilities.filtering;
const {RERENDER_SETTINGS} = FrankerFaceZ.utilities.constants;

import STYLE_URL from './styles.scss';

import { UNICODE_SCRIPTS, UNICODE_CATEGORIES } from './constants';

let invalid = [];
for(const [key,val] of Object.entries(UNICODE_CATEGORIES)) {
	try {
		new RegExp(`\\p{${key}}`, 'u');
	} catch {
		invalid.push(val);
	}
}
if ( invalid.length )
	console.log('Invalid Categories: ', invalid.join(', '));

invalid = [];
for(const script of UNICODE_SCRIPTS) {
	try {
		new RegExp(`\\p{Script=${script}}`, 'u');
	} catch {
		invalid.push(script);
	}
}
if ( invalid.length )
	console.log('Invalid scripts: ', invalid.join(', '));

const SCROLLBACK_LIMIT = 20;

const NON_TEXT_TYPES = [
	'cheer',
	'emote',
	'emoji'
];

const BAD_TYPES = [
	'resub',
	'sub_gift',
	'sub_mystery'
];

import * as RULES from './rules';

class PrattleNot extends Addon {
	constructor(...args) {
		super(...args);

		this.inject('chat');
		this.inject('chat.overrides');
		this.inject('settings');
		this.inject('i18n');
		this.injectAs('site_chat', 'site.chat');
		this.inject('site.fine');

		this.ChatScroller = this.fine.define('chat-scroller');

		this.settings.add('pn.show-reason', {
			default: true,
			ui: {
				path: 'Add-Ons > PrattleNot >> Appearance',
				title: 'Show Matching Filters',
				component: 'setting-check-box'
			},
			changed: () => this.rerenderLines()
		});

		this.settings.add('pn.show-badges', {
			default: true,
			ui: {
				path: 'Add-Ons > PrattleNot >> Appearance',
				title: 'Show Badges',
				component: 'setting-check-box'
			},
			changed: () => this.rerenderLines()
		});

		this.settings.add('pn.timestamps', {
			default: null,
			requires: ['context.chat.showTimestamps'],
			process(ctx, val) {
				if ( val === null )
					return ctx.get('context.chat.showTimestamps')
				return val;
			},
			ui: {
				path: 'Add-Ons > PrattleNot >> Appearance',
				title: 'Show Timestamps',
				component: 'setting-check-box'
			},
			changed: () => this.rerenderLines()
		});

		this.settings.add('pn.threshold', {
			default: 0,
			ui: {
				path: 'Add-Ons > PrattleNot >> Behavior',
				title: 'Threshold',
				description: 'A score higher than this value will cause a message to be flagged.',
				component: 'setting-text-box',
				process: 'to_int'
			}
		});

		this.settings.add('pn.rules', {
			default: [
				{v: {type: 'cheer', data:{
					critical: false,
					score: -100,
					 min_bits: 1
				}}},
				{v: {type: 'emote_only', data: {
					score: 100,
					critical: false,
					max_emotes: 5
				}}},
				{v: {type: 'uppercase', data: {
					score: 10,
					critical: false,
					threshold: 0.3
				}}},
				{v: {type: 'spam', data: {
					score: 20,
					critical: false
				}}},
				{v: {type: 'unicode', data: {
					score: 3,
					critical: false,
					threshold: 0.3,
					terms: [
						{t: 'cat', v: 'Letter'},
						{t: 'cat', v: 'Number'},
						{t: 'cat', v: 'Punctuation'},
						{t: 'cat', v: 'Separator'}
					]
				}}},
				{v: {type: 'splitting', data: {
					score: 10,
					critical: false,
					limit: 5
				}}},
				{v: {type: 'repeated_message', data: {
					score: 100,
					critical: false,
					hash_count: 50,
					leven_count: 100,
					leven_score: 0.3
				}}},
				{v: {type: 'repeated_words', data: {
					score: 3,
					critical: false
				}}}
			],

			type: 'array_merge',
			inherit_default: true,

			ui: {
				path: 'Add-Ons > PrattleNot >> Rules @{"description": "Rules allow you to define a series of conditions under which PrattleNot will flag a message as prattle, or spam, and display it separately from more valuable chat messages."}',
				component: 'setting-filter-editor',
				data: () => deep_copy(this.rules),
				test_context: () => ({
					source: {
						bits: 0,
						badges: {},
						text: 'This is a test.'
					}
				})
			},
			changed: () => this.rebuildTester()
		});

		this.rules = {};
		this.prattle = [];
		this.pending = [];

		for(const key in RULES)
			if ( has(RULES, key) )
				this.rules[key] = RULES[key];

		this.performUpdate = this.performUpdate.bind(this);
		this.onClickUndelete = this.onClickUndelete.bind(this);
	}

	rebuildTester() {
		const rules = this.settings.get('pn.rules');
		if ( ! rules || ! rules.length ) {
			this.tester = null;
			return;
		}

		this.tester = createTester(rules, this.rules);
	}

	onEnable() {
		this.on('chat:receive-message', this.handleMessage, this);
		this.on('chat:mod-user', this.handleMod, this);
		this.on('chat:clear-chat', this.handleClear, this);
		this.on('site.router:route', this.handleClear, this);

		this.rebuildTester();

		for(const setting of RERENDER_SETTINGS)
			this.chat.context.on(`changed:${setting}`, this.rerenderLines, this);

		if ( ! this.style_link )
			document.head.appendChild(this.style_link = createElement('link', {
				href: STYLE_URL,
				rel: 'stylesheet',
				type: 'text/css',
				crossOrigin: 'anonymous'
			}));

		this.ChatScroller.ready((cls, instances) => {
			for(const inst of instances)
				this.checkContainer(inst);
		});

		this.ChatScroller.on('mount', this.checkContainer, this);
		this.ChatScroller.on('update', this.checkContainer, this);
	}

	onDisable() {
		if ( this.style_link ) {
			this.style_link.remove();
			this.style_link = null;
		}

		for(const setting of RERENDER_SETTINGS)
			this.chat.context.off(`changed:${setting}`, this.rerenderLines, this);

		this.off('chat:receive-message', this.handleMessage, this);
		this.off('chat:mod-user', this.handleMod, this);
		this.off('chat:clear-chat', this.handleClear, this);

		this.ChatScroller.off('mount', this.checkContainer, this);
		this.ChatScroller.off('update', this.checkContainer, this);
	}

	rerenderLines() {
		if ( ! this.cont )
			return;

		for(const msg of this.prattle) {
			if ( msg.prattle_line )
				this.renderLine(msg);
		}
	}

	getContainer() {
		if ( ! this.container )
			this.container = (<div
				class="ffz-pn--list chat-list--other font-scale--default"
				data-simplebar
			>
				{this.cont = <div role="log" />}
			</div>);

		return this.container;
	}

	checkContainer(inst) {
		const node = this.fine.getChildNode(inst),
			container = this.getContainer();

		if ( ! node || ! container || node.contains(container) )
			return;

		node.insertBefore(container, node.firstElementChild);
		this.scroller = inst;
	}

	handleMod(action, user, msg_id) {
		const is_delete = action === this.site_chat.mod_types.Delete && msg_id != null;

		let i = this.prattle.length;
		while(i--) {
			const msg = this.prattle[i];
			if ( msg.user.login !== user || msg.deleted || (is_delete && msg.id !== msg_id) )
				continue;

			msg.deleted = true;
			if ( msg.prattle_line ) {
				const el = msg.prattle_line.querySelector('.message');
				if ( el )
					el.textContent = this.i18n.t('chat.message-deleted', '<message deleted>');
				else
					this.renderLine(msg);
			}
		}

		i = this.pending.length;
		while(i--) {
			const msg = this.pending[i];
			if ( msg.user.login !== user || msg.deleted || (is_delete && msg.id !== msg_id) )
				continue;

			msg.deleted = true;
		}
	}

	handleClear() {
		// Just clear everything.
		this.pending = [];
		this.prattle = [];

		if ( this.cont )
			this.cont.innerHTML = '';
	}

	addPrattle(msg) {
		this.pending.push(msg);
		if ( this.pending.length > SCROLLBACK_LIMIT )
			this.pending.splice(0, this.pending.length - SCROLLBACK_LIMIT);

		this.scheduleUpdate();
	}

	renderLine(msg) {
		let room = msg.roomLogin ? msg.roomLogin : msg.channel ? msg.channel.slice(1) : undefined,
			room_id = msg.roomId;

		if ( ! room && room_id ) {
			const r = this.chat.getRoom(room_id, null, true);
			if ( r && r.login )
				room = msg.roomLogin = r.login;

		} else if ( ! room_id && room ) {
			const r = this.chat.getRoom(null, room, true);
			if ( r && r.id )
				room_id = msg.roomId = r.id;
		}

		const is_action = msg.messageType === this.site_chat.message_types?.Action,
			action_style = is_action ? this.chat.context.get('chat.me-style') : 0,
			action_italic = action_style >= 2,
			action_color = action_style === 1 || action_style === 3,

			raw_color = this.overrides.getColor(msg.user.id) || msg.user.color,
			color = this.site_chat.colors.process(raw_color),

			bg_css = msg.mentioned && msg.mention_color ? this.site_chat.inverse_colors.process(msg.mention_color) : null;

		const user_block = this.chat.formatUser(msg.user, createElement);
		//const override_name = this.overrides.getName(msg.user.id);

		const show_reasons = this.settings.get('pn.show-reason');

		let reasons = null;
		if ( show_reasons && msg.prattle_reasons )
			reasons = `[${msg.prattle_score}=${msg.prattle_reasons.join(', ')}]`;

		const reason_el = reasons ? (<span class="pn--reasons tw-pd-l-05 tw-c-text-alt-2">
			{ reasons }
		</span>) : null;

		const line = (<div
			class="chat-line__message"
			data-room={room}
			data-room-id={room_id}
			data-user={msg.user.login}
			data-user-id={msg.user.id}
		>
			{this.settings.get('pn.timestamps') ? (<span class="chat-line__timestamp">
				{ this.chat.formatTime(msg.timestamp) }
			</span>) : null}
			{this.settings.get('pn.show-badges') ? (<span class="chat-line__message--badges">
				{ this.chat.badges.render(msg, createElement) }
			</span>) : null}
			<span
				class="chat-line__username notranslate"
				role="button"
				style={{color}}
			>
				{ user_block }
			</span>
			<span aria-hidden="true">
				{is_action && ! action_italic ? ' ' : ': '}
			</span>
			<span
				class={`message ${action_italic ? 'chat-line__message-body--italicized' : ''}`}
				style={action_color ? {color} : null}
			>
				{ msg.deleted ?
					<a href="" onClick={this.onClickUndelete}>
						{this.i18n.t('chat.message-deleted', '<message deleted>')}
					</a> :
					this.chat.renderTokens(msg.ffz_tokens, createElement)
				}
			</span>
			{reason_el}
		</div>);

		line.message = msg;

		if ( msg.prattle_line )
			msg.prattle_line.replaceWith(line);
		msg.prattle_line = line;

		return line;
	}

	onClickUndelete(event) {
		event.preventDefault();

		const line = event.target.closest('.chat-line__message'),
			msg = line?.message;

		if ( msg ) {
			msg.deleted = false;
			this.renderLine(msg);
		}

		return false;
	}

	scheduleUpdate() {
		if ( ! this._update_raf )
			this._update_raf = requestAnimationFrame(this.performUpdate);
	}

	performUpdate() {
		this._update_raf = null;

		if ( ! this.log )
			this.getContainer();

		const pending = this.pending;
		this.pending = [];

		const scroller = this.cont.parentElement.parentElement;

		for(const msg of pending) {
			if ( msg.deleted || msg.ffz_removed )
				continue;

			const line = this.renderLine(msg);
			if ( line ) {
				this.cont.appendChild(line);
				this.prattle.push(msg);
			}
		}

		this.trimPrattle();

		scroller.scrollTop = scroller.scrollHeight;
	}

	trimPrattle() {
		let to_remove = Math.max(0, this.prattle.length - SCROLLBACK_LIMIT);
		if ( to_remove % 2 )
			to_remove--;

		while ( to_remove ) {
			const msg = this.prattle.shift();
			if ( msg.prattle_line ) {
				msg.prattle_line.remove();
				msg.prattle_line = null;
			}
			to_remove--;
		}
	}

	handleMessage(event) {
		if ( ! event.message || ! this.tester || event.defaultPrevented )
			return;

		const msg = event.message;
		if ( msg.ffz_removed || msg.deleted || ! msg.ffz_tokens )
			return;

		const type = msg.ffz_type;
		if ( type && BAD_TYPES.includes(type) )
			return;

		const threshold = this.settings.get('pn.threshold') ?? 0,
			debugging = true;

		const ctx = {
			source: msg,
			msg: msg.message,
			tokens: msg.ffz_tokens,
			score: 0,
			threshold
		};

		if ( debugging ) {
			ctx.reasons = [];
			ctx.threshold = Infinity;
		}

		Object.defineProperty(ctx, 'text', {
			get() {
				if ( ctx._text )
					return ctx._text;

				const out = [],
					t = ctx.tokens,
					l = t.length;
				for(let i=0; i < l; i++) {
					const token = t[i];
					if ( token.text && ! NON_TEXT_TYPES.includes(token.type) )
						out.push(token.text);
				}

				return ctx._text = out.join('').trim();
			}
		});

		const result = this.tester(ctx);
		if ( ctx.score > threshold ) {
			msg.prattle_reasons = ctx.reasons;
			msg.prattle_score = ctx.score;
			this.addPrattle(msg);
			event.preventDefault();
		}
	}
}

PrattleNot.register();
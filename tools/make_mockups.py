#!/usr/bin/env python3
# ============================================================================
# LOGS VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

import os
from xml.sax.saxutils import escape

OUT = 'mockups'
W = 780
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
BG, PANEL, ROW = '#1a1a1a', '#242424', '#2e2e2e'
BORDER = 'rgba(255,255,255,.10)'
BORDER2 = 'rgba(255,255,255,.18)'
T85, T65, T45, T30, T18 = (f'rgba(255,255,255,{a})' for a in ('.85', '.65', '.45', '.30', '.18'))
BLUE = '#42a5f5'
ACCENT = '#f47d42'
GREEN = '#4caf50'
ACTIVE = '#4299e4'
YELLOW = '#ffb300'
INFO, WARN, ERR, CRIT = '#378ADD', '#EF9F27', '#E5622A', '#D43A3A'
RUN, STOP, IDLE = '#2ecc71', '#e74c3c', '#6a6a6a'
C_SYS, C_DOCKER, C_VM, C_SCRIPT, C_CUSTOM = '#378ADD', '#1D9E75', '#EF9F27', '#D9456E', '#A45EE5'
CH = 0.6

def n(v):
    return f'{round(v, 2):g}' if isinstance(v, float) else str(v)

def cx(x0, chars, size=9.5):
    return x0 + chars * size * CH

class Svg:
    def __init__(self, height, label):
        self.h, self.label, self.el = height, label, []

    def add(self, s):
        self.el.append(s)
        return self

    def rect(self, x, y, w, h, rx=3, fill=ROW, stroke=BORDER, opacity=None, sw=None):
        a = f'<rect x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}"'
        if rx: a += f' rx="{n(rx)}"'
        a += f' fill="{fill}"'
        if stroke: a += f' stroke="{stroke}"'
        if sw: a += f' stroke-width="{n(sw)}"'
        if opacity is not None: a += f' opacity="{n(opacity)}"'
        return self.add(a + '/>')

    def panel(self, x, y, w, h):
        return self.rect(x, y, w, h, rx=4, fill=PANEL)

    def text(self, x, y, s, fill=T85, size=11, anchor='start', weight='normal', mono=False, ls=None):
        a = f'<text x="{n(x)}" y="{n(y)}" fill="{fill}" font-size="{n(size)}" text-anchor="{anchor}" font-weight="{weight}"'
        if mono: a += f' font-family="{MONO}" textLength="{n(len(s) * size * CH)}"'
        if ls: a += f' letter-spacing="{n(ls)}"'
        return self.add(a + f' xml:space="preserve">{escape(s)}</text>')

    def spans(self, x, y, parts, size=9.5, mono=True, anchor='start', weight=None, ls=None):
        body = ''
        chars = 0
        for p in parts:
            t, c = p[0], p[1]
            w = f' font-weight="{p[2]}"' if len(p) > 2 else ''
            body += f'<tspan fill="{c}"{w}>{escape(t)}</tspan>'
            chars += len(t)
        a = f'<text x="{n(x)}" y="{n(y)}" font-size="{n(size)}" text-anchor="{anchor}"'
        if weight: a += f' font-weight="{weight}"'
        if mono: a += f' font-family="{MONO}" textLength="{n(chars * size * CH)}"'
        if ls: a += f' letter-spacing="{n(ls)}"'
        return self.add(a + f' xml:space="preserve">{body}</text>')

    def path(self, d, stroke=T65, sw=1.4, fill='none', extra=''):
        a = f'<path d="{d}" fill="{fill}"'
        if stroke and stroke != 'none': a += f' stroke="{stroke}" stroke-width="{n(sw)}"'
        return self.add(a + f'{extra}/>')

    def line(self, x1, y1, x2, y2, stroke=BORDER, sw=1):
        return self.add(f'<path d="M{n(x1)} {n(y1)}L{n(x2)} {n(y2)}" stroke="{stroke}" stroke-width="{n(sw)}"/>')

    def circle(self, cx_, cy, r, fill='none', stroke=None, sw=1.4, opacity=None):
        a = f'<circle cx="{n(cx_)}" cy="{n(cy)}" r="{n(r)}" fill="{fill}"'
        if stroke: a += f' stroke="{stroke}" stroke-width="{n(sw)}"'
        if opacity is not None: a += f' opacity="{n(opacity)}"'
        return self.add(a + '/>')

    def arrow(self, x1, y1, x2, y2):
        return self.arrow_d(f'M{n(x1)} {n(y1)}L{n(x2)} {n(y2)}')

    def arrow_d(self, d):
        return self.add(f'<path d="{d}" fill="none" stroke="{BLUE}" stroke-width="1.6" marker-end="url(#a)"/>')

    def note(self, x, y, s, anchor='start'):
        return self.text(x, y, s, fill=BLUE, size=10.5, anchor=anchor, weight='600')

    def check(self, x, y, on=True, dim=False, size=11):
        self.rect(x, y, size, size, rx=2, fill='none', stroke=BLUE if on else (T18 if dim else T45), sw=1.2)
        if on:
            k = size / 11
            self.path(f'M{n(x + 2.4 * k)} {n(y + 5.6 * k)}l{n(2.2 * k)} {n(2.2 * k)} {n(4 * k)} {n(-4.4 * k)}', stroke=BLUE, sw=1.5)
        return self

    def dot(self, cx_, cy, color, r=3):
        return self.circle(cx_, cy, r, fill=color)

    def caret(self, x, y, color=T45):
        return self.path(f'M{n(x)} {n(y)}l3 3.4 3-3.4z', stroke=None, fill=color)

    def tri(self, x, y, d, color=T45, k=3.4):
        pts = {'up': f'M{n(x - k)} {n(y + k / 2)}l{n(k)} {n(-k)} {n(k)} {n(k)}z',
               'left': f'M{n(x + k / 2)} {n(y - k)}l{n(-k)} {n(k)} {n(k)} {n(k)}z',
               'right': f'M{n(x - k / 2)} {n(y - k)}l{n(k)} {n(k)} {n(-k)} {n(k)}z'}[d]
        return self.path(pts, stroke=None, fill=color)

    def pill(self, xr, y, label, w):
        self.rect(xr - w, y, w, 14, rx=3, fill='rgba(255,140,0,.08)', stroke='rgba(255,140,0,.5)')
        return self.text(xr - w / 2, y + 10.3, label, fill=T65, size=8.5, anchor='middle')

    def btn(self, x, y, w, label, h=17, fill='rgba(255,255,255,.035)', stroke='rgba(255,255,255,.15)', color=T65, size=8.5, weight='500'):
        self.rect(x, y, w, h, fill=fill, stroke=stroke)
        return self.text(x + w / 2, y + h / 2 + 3, label, fill=color, size=size, anchor='middle', weight=weight)

    def field(self, x, y, w, label='', h=20, mono=False, color=T85, weight='normal', stroke='rgba(255,255,255,.14)', size=10):
        self.rect(x, y, w, h, fill='#1e1e1e', stroke=stroke)
        if label:
            self.text(x + 8, y + h / 2 + 3.5, label, fill=color, size=size, mono=mono, weight=weight)
        return self

    def select(self, x, y, w, label, h=20, color=T85):
        self.field(x, y, w, label, h=h, color=color)
        return self.caret(x + w - 14, y + h / 2 - 1.5)

    def note_bar(self, x, y, w, parts, h=16):
        self.rect(x, y, w, h, rx=2, fill='rgba(255,179,0,.10)', stroke=None)
        self.rect(x, y, 2.5, h, rx=0, fill=YELLOW, stroke=None)
        self.i_info(x + 11, y + h / 2)
        return self.spans(x + 20, y + h / 2 + 3.3, parts, size=9.5, mono=False)

    def i_info(self, x, y, color=YELLOW):
        self.circle(x, y, 4, stroke=color, sw=1)
        self.path(f'M{n(x)} {n(y - 0.4)}v2.6', stroke=color, sw=1.1)
        return self.circle(x, y - 2, 0.6, fill=color)

    def i_trash(self, x, y, color=T45):
        return self.path(f'M{n(x - 5)} {n(y - 3)}h10M{n(x - 3)} {n(y - 3)}v8h6v-8M{n(x - 1.5)} {n(y - 5)}h3', stroke=color, sw=1.1)

    def i_refresh(self, x, y, color=T65):
        self.path(f'M{n(x + 4)} {n(y)}a4 4 0 1 1-1.4-3', stroke=color, sw=1.3)
        return self.path(f'M{n(x + 3.6)} {n(y - 5.5)}v3h-3', stroke=color, sw=1.3)

    def i_down(self, x, y, color=T65):
        return self.path(f'M{n(x)} {n(y - 5)}v9M{n(x - 3.5)} {n(y + 0.5)}l3.5 3.5 3.5-3.5', stroke=color, sw=1.3)

    def i_list(self, x, y, color=T65):
        self.rect(x - 5, y - 4.5, 10, 9, rx=1.5, fill='none', stroke=color, sw=1.1)
        return self.path(f'M{n(x - 2.5)} {n(y - 1.8)}h5M{n(x - 2.5)} {n(y + 0.2)}h5M{n(x - 2.5)} {n(y + 2.2)}h5', stroke=color, sw=0.9)

    def i_cog(self, x, y, color=T65):
        self.circle(x, y, 3.2, stroke=color, sw=1.3)
        self.circle(x, y, 1, fill=color)
        d = ''
        for dx, dy in ((0, -1), (0.7, -0.7), (1, 0), (0.7, 0.7), (0, 1), (-0.7, 0.7), (-1, 0), (-0.7, -0.7)):
            d += f'M{n(x + dx * 3.9)} {n(y + dy * 3.9)}L{n(x + dx * 5.4)} {n(y + dy * 5.4)}'
        return self.path(d, stroke=color, sw=1.5)

    def i_search(self, x, y, color=T45):
        self.circle(x, y, 3, stroke=color, sw=1.1)
        return self.path(f'M{n(x + 2.2)} {n(y + 2.2)}l2.6 2.6', stroke=color, sw=1.1)

    def i_clock(self, x, y, color=T45):
        self.circle(x, y, 4.4, stroke=color, sw=1.1)
        return self.path(f'M{n(x)} {n(y - 2.5)}v2.8l1.9 1.2', stroke=color, sw=1.1)

    def i_filter(self, x, y, color=T65):
        return self.path(f'M{n(x - 4)} {n(y - 3.5)}h8l-3 3.6v3.2l-2 1v-4.2z', stroke=None, fill=color)

    def i_link(self, x, y, color=ACCENT):
        return self.path(f'M{n(x - 1)} {n(y + 1)}l2-2M{n(x - 1.5)} {n(y - 1.5)}l1.5-1.5a2 2 0 0 1 3 3l-1.5 1.5'
                         f'M{n(x + 1.5)} {n(y + 1.5)}l-1.5 1.5a2 2 0 0 1-3-3l1.5-1.5', stroke=color, sw=1.1)

    def i_copy(self, x, y, color=T65):
        self.rect(x - 4, y - 2.5, 6, 7, rx=1, fill='none', stroke=color, sw=1)
        return self.path(f'M{n(x - 1.5)} {n(y - 2.5)}v-2h6v7h-2', stroke=color, sw=1)

    def i_mute(self, x, y, color=T65):
        self.path(f'M{n(x - 4.5)} {n(y - 1.6)}h2.2l2.8-2.4v8l-2.8-2.4h-2.2z', stroke=None, fill=color)
        return self.path(f'M{n(x + 2)} {n(y - 2)}l3.6 4M{n(x + 5.6)} {n(y - 2)}l-3.6 4', stroke=color, sw=1)

    def i_ext(self, x, y, color=ACCENT):
        return self.path(f'M{n(x - 2.5)} {n(y + 2.5)}l5-5M{n(x - 0.8)} {n(y - 2.5)}h3.3v3.3', stroke=color, sw=1)

    def i_x(self, x, y, color=T45, k=2.6):
        return self.path(f'M{n(x - k)} {n(y - k)}l{n(2 * k)} {n(2 * k)}M{n(x + k)} {n(y - k)}l{n(-2 * k)} {n(2 * k)}', stroke=color, sw=1.2)

    def i_logs(self, x, y, color=T65):
        self.path(f'M{n(x)} {n(y)}h13l6 6v15a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2v-19a2 2 0 0 1 2-2z', stroke=color)
        return self.path(f'M{n(x + 2)} {n(y + 9)}h11M{n(x + 2)} {n(y + 13)}h11M{n(x + 2)} {n(y + 17)}h7', stroke=color, sw=1.2)

    def out(self):
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{self.h}" viewBox="0 0 {W} {self.h}" '
                f'font-family="{FONT}" role="img" aria-label="{escape(self.label)}"><title>{escape(self.label)}</title>'
                f'<rect width="{W}" height="{self.h}" rx="6" fill="{BG}"/>'
                f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">'
                f'<path d="M0 0l10 5-10 5z" fill="{BLUE}"/></marker></defs>')
        return head + ''.join(self.el) + '</svg>\n'

LOGBG = '#161616'
W_HDR, W_WARN, W_ERR = '#aaaaaa', '#ffbf00', '#ff8c00'
T_INFO, T_WARN, T_ERR, T_OK = '#378ADD', '#EF9F27', '#D43A3A', '#4caf50'
LEVEL = {'': T65, 'info': T_INFO, 'warning': T_WARN, 'error': T_ERR, 'success': T_OK}
M_SYSLOG, M_PLEX, M_HOSTS = '#e91e63', '#4caf50', '#378ADD'

def rgba(hexc, a):
    c = hexc.lstrip('#')
    return f'rgba({int(c[0:2], 16)},{int(c[2:4], 16)},{int(c[4:6], 16)},{a})'

def file_icon(s, cx_, y, color):
    x = cx_ - 9
    s.path(f'M{x} {y}h9l6 6v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V{y + 2}a2 2 0 0 1 2-2z', stroke=color)

def sec_header(s, title, pill, pw):
    s.rect(14, 14, 752, 24)
    s.text(26, 30, title, size=11, weight='600')
    s.pill(736, 19, pill, pw)
    s.tri(749, 26, 'up', T30)

def sidebar(s, x, y, groups):
    for title, count, rows in groups:
        s.text(x + 10, y + 14, title, fill=T45, size=8.5, weight='700', ls=0.4)
        s.rect(x + 176, y + 4, 17, 12, fill='rgba(255,255,255,.06)', stroke=None)
        s.text(x + 184.5, y + 13, str(count), fill=T45, size=8, anchor='middle', weight='700')
        y += 20
        for name, dot, size, state in rows:
            tx = x + 26
            if state == 'active':
                s.rect(x, y, 202, 19, rx=0, fill='rgba(66,153,244,.14)', stroke=None)
                s.rect(x, y, 2, 19, rx=0, fill=ACTIVE, stroke=None)
            elif state == 'ticked':
                s.rect(x, y, 202, 19, rx=0, fill='rgba(255,255,255,.05)', stroke=None)
                s.path(f'M{x + 9} {y + 9.8}l2.3 2.3 4-4.6', stroke=ACTIVE, sw=1.5)
                tx = x + 36
            s.dot(tx - 9, y + 9.5, dot, r=2.8)
            s.text(tx, y + 13.2, name, fill=ACTIVE if state == 'active' else (T85 if state == 'ticked' else T65), size=10.5,
                   weight='600' if state == 'active' else 'normal')
            s.text(x + 193, y + 13, size, fill=T45, size=8.5, anchor='end')
            y += 19
        y += 6
    return y

def toolbar(s, x, y, xr, counts, mode):
    for label, val, col, w in (('INFO', counts[0], T_INFO, 62), ('WARNINGS', counts[1], T_WARN, 88), ('ERRORS', counts[2], T_ERR, 68),
                               ('CRITICAL', counts[3], T30, 78)):
        s.rect(x, y, w, 20, fill='rgba(255,255,255,.04)', stroke=col, sw=1)
        s.spans(x + w / 2, y + 13.5, [(label + ' ', col, '500'), (val, col, '700')], size=8.5, mono=False, anchor='middle', ls=0.3)
        x += w + 5
    s.rect(x, y, 66, 20, fill='rgba(255,255,255,.04)', stroke=BORDER2)
    s.i_filter(x + 11, y + 10)
    s.text(x + 20, y + 13.5, 'FILTER', fill=T65, size=8.5, weight='500', ls=0.3)
    s.caret(x + 53, y + 8.5)
    for name, mx in (('LIVE', xr - 88), ('MERGE', xr - 43)):
        on = name.lower() == mode
        s.rect(mx, y, 43, 20, fill='rgba(76,175,80,.10)' if on else 'rgba(255,255,255,.04)', stroke='rgba(76,175,80,.40)' if on else BORDER2)
        s.text(mx + 21.5, y + 13.5, name, fill=GREEN if on else T65, size=8.5, anchor='middle', weight='600', ls=0.3)

def statusbar(s, x, y, w, total, live):
    s.rect(x, y, w, 22, fill='rgba(255,255,255,.03)', stroke='rgba(255,255,255,.06)')
    s.spans(x + 10, y + 14.8, [(total, T85, '700'), (' lines', T45)], size=9.5, mono=False)
    s.rect(x + 164, y + 3.5, 190, 15, fill='rgba(255,255,255,.04)')
    s.i_search(x + 174, y + 10.5)
    s.text(x + 184, y + 14.5, 'Search current log...', fill=T30, size=9)
    if live:
        s.rect(x + w - 82, y + 3.5, 74, 15, fill='rgba(76,175,80,.10)', stroke='rgba(76,175,80,.30)')
        s.dot(x + w - 73, y + 11, GREEN, r=2.6)
        s.text(x + w - 14, y + 14.3, '5sec · LIVE', fill=GREEN, size=8.5, anchor='end', ls=0.2)

def tool_lines(s, x, y, w, lines, pitch=16.5):
    for i, (text, lvl) in enumerate(lines):
        if i % 2 == 1:
            s.rect(x - 9, y + i * pitch - 11.5, w, pitch, rx=0, fill='rgba(255,255,255,.03)', stroke=None)
        s.text(x, y + i * pitch, text, fill=LEVEL[lvl], size=9.5, mono=True)

made = []

s = Svg(172, 'The Viewers Suite section on the Tools page')
s.rect(14, 14, 752, 26)
s.text(26, 31, 'Viewers Suite', size=12, weight='600')
s.panel(14, 46, 752, 78)
for cx_, name in ((90, 'Disk Viewer'), (240, 'Files Viewer'), (390, 'Logs Viewer'), (540, 'Stream Viewer')):
    c = BLUE if name == 'Logs Viewer' else T65
    file_icon(s, cx_, 62, c)
    s.text(cx_, 106, name, fill=c, size=10.5, anchor='middle')
s.arrow(528, 150, 400, 116)
s.note(540, 154, 'Tools > Viewers Suite > Logs Viewer')
made.append(('01-where-it-lives.svg', s.out()))

s = Svg(350, 'Ticking log sources on a settings tab')
x = 14
for name, w, on in (('Dashboard Widget', 126, True), ('Tool Page', 84, False), ('Backup Logs', 96, False), ('Alerts', 66, False)):
    s.rect(x, 14, w, 23, fill=PANEL if on else '#1e1e1e', stroke='rgba(244,125,66,.45)' if on else BORDER)
    s.text(x + w / 2, 29.5, name, fill=T85 if on else T45, size=10, anchor='middle', weight='600')
    x += w + 2
s.note(754, 29.5, 'Each tab keeps its own ticks', anchor='end')
s.arrow(548, 26, 402, 26)
s.panel(14, 41, 752, 256)
s.rect(22, 49, 736, 22)
s.text(32, 64, 'Log source options', size=11, weight='600')
s.pill(734, 53, 'Widget only', 62)
s.tri(747, 60, 'up', T30)

def card(y, title, rows, note=None, scan=False):
    h = 20 + 20 * len(rows) + (22 if note else 0) + 23
    s.rect(30, y, 720, h, fill='#1c1c1c')
    s.rect(30, y, 720, 20, fill=ROW)
    s.text(40, y + 14, title, size=10.5, weight='600')
    s.tri(738, y + 10, 'up', T30)
    yy = y + 20
    for i, (on, grey, name, path, state, size) in enumerate(rows):
        s.rect(30.5, yy, 719, 20, rx=0, fill='#1e1e1e' if i % 2 == 0 else '#1a1a1a', stroke=None)
        s.rect(30.5, yy, 170, 20, rx=0, fill='rgba(0,0,0,.20)', stroke=None)
        s.check(40, yy + 4.5, on=on, dim=grey)
        s.text(58, yy + 14, name, fill=T30 if grey else T85, size=10.5, weight='600')
        if path:
            s.text(212, yy + 13.5, path, fill=T18 if grey else T45, size=9, mono=True)
        if state:
            s.dot(216, yy + 10, state[1], r=2.6)
            s.text(224, yy + 13.5, state[0], fill=T65, size=9.5)
        s.text(740, yy + 13.5, size, fill=T18 if grey else T65, size=9.5, anchor='end')
        yy += 20
    if note:
        s.note_bar(40, yy + 3, 232, [(note, T85)])
        yy += 22
    s.line(30.5, yy, 749.5, yy, stroke='rgba(255,255,255,.06)')
    s.btn(40, yy + 3, 58, 'Select All')
    s.btn(103, yy + 3, 68, 'Deselect All')
    if scan:
        s.rect(688, yy + 3, 52, 17, fill='rgba(255,255,255,.035)', stroke='rgba(255,255,255,.15)')
        s.i_refresh(700, yy + 11.5, T65)
        s.text(721, yy + 14.5, 'Scan', fill=T65, size=8.5, anchor='middle', weight='500')

card(77, 'System Logs', [
    (True, False, 'Syslog', '/var/log/syslog', None, '1.2 MB'),
    (True, False, 'Dmesg', '/var/log/dmesg', None, '84.3 KB'),
    (False, True, 'PHP Log', '/var/log/phplog', None, '0 B'),
], note='Greyed-out items have no entries (0 B).')
card(208, 'Docker Containers Log', [
    (True, False, 'plex', '', ('running', RUN), '3.4 MB'),
    (False, False, 'old-backup', '', ('exited', STOP), '12.4 KB'),
], scan=True)
s.note(26, 318, 'A greyed row cannot be ticked: there is nothing in that log yet.')
s.note(26, 336, 'Scan looks again, for a container that was added after the page opened.')
made.append(('02-ticking-sources.svg', s.out()))

s = Svg(304, 'The Dashboard widget')
s.panel(14, 14, 752, 232)
s.i_logs(28, 21)
s.text(58, 35, 'LOGS VIEWER', size=12.5, weight='700')
s.rect(58, 43, 22, 11, rx=5.5, fill='rgba(0,136,204,.30)', stroke='#0088cc', sw=1)
s.circle(74.5, 48.5, 3.6, fill=T85)
s.spans(87, 52, [('Autoscroll ', T65), ('On', '#0a9be0')], size=9.5, mono=False, weight='600')
for i, hx in enumerate((668.5, 693.5, 718.5, 743.5)):
    s.rect(hx - 10.5, 22, 21, 21)
    (s.i_refresh, s.i_down, s.i_list, s.i_cog)[i](hx, 32.5)
s.field(658, 48, 96, 'Search...', h=16, color=T30, size=9)

s.rect(26, 72, 426, 25, rx=5, fill='rgba(255,255,255,.05)', stroke=None)
x = 30
for name, col, w in (('System', C_SYS, 80), ('Docker', C_DOCKER, 78), ('VMs', C_VM, 62), ('User Scripts', C_SCRIPT, 112), ('Custom', C_CUSTOM, 82)):
    on = name == 'System'
    if on:
        s.rect(x, 75, w, 19, fill='#1b1b1b', stroke='rgba(255,255,255,.14)')
    s.dot(x + 11, 84.5, col)
    s.text(x + 19, 88, name, fill=T85 if on else T45, size=10, weight='600')
    s.caret(x + w - 13, 83, T45 if on else T30)
    x += w + 1
for name, cxr, w in (('Syntax', 622, 66), ('Filter', 692, 62)):
    s.rect(cxr, 73, w, 23, fill='#1b1b1b')
    s.text(cxr + 10, 88, name, fill=T65, size=10, weight='600')
    s.caret(cxr + w - 14, 83, T30)

s.rect(26, 104, 728, 86, rx=2, fill='#1b1b1b')
for i, (hdr, rest) in enumerate((
    ('Nov 11 14:02:11 Raptor1 kernel:', [(' mdcmd (36): check correct', T85)]),
    ('Nov 11 14:02:19 Raptor1 emhttpd:', [(' read SMART /dev/sdc', T85)]),
    ('Nov 11 14:02:27 Raptor1 nginx:', [(' ', T85), ('warning', W_WARN, '700'), (': upstream response is buffered', T85)]),
    ('Nov 11 14:02:31 Raptor1 kernel:', [(' I/O ', T85), ('error', W_ERR, '700'), (', dev sdc, sector 2048', T85)]),
    ('Nov 11 14:02:36 Raptor1 webGUI:', [(' Successful login user root from 10.0.0.12', T85)]),
)):
    s.spans(36, 121 + i * 14.5, [(hdr, W_HDR)] + rest)
s.path('M751 187.5l1.5-1.5M747.5 187.5l5-5M744 187.5l8.5-8.5', stroke=T30, sw=0.9)

s.rect(26, 190, 728, 3, rx=0, fill='rgba(255,255,255,.07)', stroke=None)
s.rect(26, 190, 627, 3, rx=0, fill='rgba(30,144,255,.55)', stroke=None)
s.rect(656, 190, 71, 3, rx=0, fill='rgba(239,159,39,.80)', stroke=None)
s.rect(727, 190, 27, 3, rx=0, fill='rgba(229,98,42,.85)', stroke=None)
s.rect(26, 193, 728, 45, rx=0, fill='rgba(255,255,255,.035)', stroke=BORDER)
s.circle(36, 206.5, 3, fill=RUN, opacity=0.7)
s.text(44, 210, '1284', size=10, weight='600')
bx = 256
for label, val, col, w, a in (('Info', '212', '#378ADD', 58, 1), ('Warnings', '24', '#EF9F27', 78, 1),
                              ('Errors', '9', '#E5622A', 56, 1), ('Critical', '0', '#D43A3A', 60, 0.5)):
    s.rect(bx, 198, w, 17, rx=5, fill=rgba(col, 0.10 * a), stroke=rgba(col, 0.35 * a))
    s.spans(bx + w / 2, 210, [(label + ' ', rgba(col, 0.85 * a), '500'), (val, rgba(col, a), '700')], size=9.5, mono=False, anchor='middle')
    bx += w + 6
s.i_clock(694, 206.5)
s.text(746, 210, '14:02:36', fill=T45, size=9.5, anchor='end')
s.rect(26.5, 219, 727, 18.5, rx=0, fill='#1b1b1b', stroke=None)
s.text(34, 231.5, 'Selected: System → Syslog', fill=T45, size=9.5)
s.spans(746, 231.5, [('+12 new lines', 'rgba(46,204,113,.85)'), ('   |   ', T18), ('+1 err', '#ff8c00'), ('   |   ', T18), ('1.2 MB', T30)],
        size=9.5, mono=False, anchor='end')

s.arrow_d('M20 262V84.5H28')
s.note(26, 272, 'A button per kind of log, with the sources you ticked.')
s.arrow(500, 262, 404, 219)
s.note(754, 272, 'Click a counter to filter, again to clear.', anchor='end')
s.note(26, 290, 'The thin strip is the share of info, warnings and errors in the log.')
made.append(('03-the-widget.svg', s.out()))

s = Svg(328, 'The Tools page')
s.panel(14, 14, 752, 38)
s.i_logs(28, 21.5)
s.text(58, 31, 'LOGS VIEWER', size=12.5, weight='700')
s.text(58, 44, 'Browse log sources from your server', fill=T45, size=9.5)
for i, hx in enumerate((718.5, 743.5)):
    s.rect(hx - 10.5, 22.5, 21, 21)
    (s.i_down, s.i_cog)[i](hx, 33)
s.panel(14, 60, 204, 230)
s.panel(226, 60, 540, 230)
sidebar(s, 15, 66, [
    ('SYSTEM', 2, [('Syslog', GREEN, '1.2 MB', 'active'), ('Dmesg', GREEN, '84.3 KB', '')]),
    ('DOCKER CONTAINERS', 2, [('plex', GREEN, '3.4 MB', ''), ('old-backup', '#e24b4a', '12.4 KB', '')]),
    ('USER SCRIPTS', 1, [('nightly_rsync', IDLE, '2.1 KB', '')]),
    ('CUSTOM', 1, [('Hosts nginx', GREEN, '640.2 KB', '')]),
])
toolbar(s, 236, 69, 756, ('212', '24', '9', '0'), 'live')
s.rect(236, 96, 520, 158, rx=2, fill=LOGBG)
tool_lines(s, 246, 113.5, 518, [
    ('Nov 11 14:01:58 Raptor1 kernel: md: sync done.', ''),
    ('Nov 11 14:02:11 Raptor1 kernel: mdcmd (36): check correct', ''),
    ('Nov 11 14:02:19 Raptor1 emhttpd: read SMART /dev/sdc', ''),
    ('Nov 11 14:02:27 Raptor1 nginx: warning: upstream response is buffered', 'warning'),
    ('Nov 11 14:02:31 Raptor1 kernel: I/O error, dev sdc, sector 2048', 'error'),
    ('Nov 11 14:02:36 Raptor1 webGUI: Successful login user root from 10.0.0.12', 'success'),
    ('Nov 11 14:02:40 Raptor1 emhttpd: spinning down /dev/sdd', ''),
    ('Nov 11 14:02:44 Raptor1 kernel: usb 1-2: new high-speed USB device', ''),
    ('Nov 11 14:02:51 Raptor1 nginx: notice: signal process started', 'info'),
])
statusbar(s, 236, 260, 520, '1,284', True)
s.arrow(64, 303, 37, 275)
s.note(26, 314, 'The dot is the state, the number the size of the log.')
s.arrow(711, 303, 711, 281)
s.note(754, 314, 'Hold the pointer over the log and it pauses.', anchor='end')
made.append(('04-the-tools-page.svg', s.out()))

s = Svg(258, 'Filtering the log on a piece of selected text')
s.panel(14, 14, 752, 84)
s.rect(26, 22, 728, 68, rx=2, fill=LOGBG)
pre = 'Nov 11 14:02:31 Raptor1 kernel: I/O error, dev '
s.rect(cx(36, len(pre)) - 1, 53.5 - 10, 3 * 9.5 * CH + 2, 13, rx=1, fill='#2f6fb5', stroke=None)
s.text(36, 38, 'Nov 11 14:02:19 Raptor1 emhttpd: read SMART /dev/sdc', fill=T65, size=9.5, mono=True)
s.spans(36, 53.5, [(pre, T_ERR), ('sdc', '#ffffff'), (', sector 2048', T_ERR)])
s.text(36, 69, 'Nov 11 14:02:33 Raptor1 nginx: warning: upstream response is buffered', fill=T_WARN, size=9.5, mono=True)
s.text(36, 84.5, 'Nov 11 14:02:36 Raptor1 webGUI: Successful login user root from 10.0.0.12', fill=T_OK, size=9.5, mono=True)
s.rect(470, 47, 160, 42, rx=4, fill='#2b2b2b', stroke=BORDER2)
s.i_copy(483, 58)
s.text(494, 61.5, 'Copy line', fill=T85, size=10)
s.line(474, 68, 626, 68, stroke='rgba(255,255,255,.08)')
s.rect(473, 71, 154, 15, rx=2, fill='rgba(244,125,66,.14)', stroke=None)
s.i_filter(483, 78.5, ACCENT)
s.text(494, 82, 'Filter on “sdc”', fill=ACCENT, size=10)
s.arrow(378, 113, 467, 85)
s.note(26, 118, 'Select a few characters, right-click, pick Filter on.')

s.panel(14, 128, 752, 96)
s.rect(26, 136, 728, 22, fill='rgba(255,255,255,.03)', stroke=BORDER)
s.rect(32, 139.5, 560, 15, fill='#1e1e1e', stroke='rgba(255,255,255,.12)')
s.i_search(42, 146.5)
s.text(52, 150.5, 'sdc', fill=T85, size=9.5)
s.text(606, 150.5, '3 of 1,284 lines', fill=T45, size=9.5)
s.rect(728, 139.5, 20, 15, fill='rgba(255,255,255,.04)')
s.i_x(738, 147)
s.rect(26, 164, 728, 52, rx=2, fill=LOGBG)
for i, (a, b, lvl) in enumerate((
    ('Nov 11 14:02:19 Raptor1 emhttpd: read SMART /dev/', '', ''),
    ('Nov 11 14:02:31 Raptor1 kernel: I/O error, dev ', ', sector 2048', 'error'),
    ('Nov 11 14:08:02 Raptor1 emhttpd: spinning down /dev/', '', ''),
)):
    y = 180 + i * 15.5
    s.rect(cx(36, len(a)) - 1, y - 10, 3 * 9.5 * CH + 2, 13, rx=1.5, fill='rgba(244,125,66,.40)', stroke=None)
    s.spans(36, y, [(a, LEVEL[lvl]), ('sdc', T85), (b, LEVEL[lvl])])
s.arrow(738, 238, 738, 157)
s.note(728, 244, 'Only the lines that contain it are left. The X brings everything back.', anchor='end')
made.append(('05-filter-on-selection.svg', s.out()))

s = Svg(272, 'Merge puts several logs in one list ordered by time')
s.panel(14, 14, 204, 222)
s.panel(226, 14, 540, 222)
sidebar(s, 15, 20, [
    ('SYSTEM', 2, [('Syslog', GREEN, '1.2 MB', 'ticked'), ('Dmesg', GREEN, '84.3 KB', '')]),
    ('DOCKER CONTAINERS', 2, [('plex', GREEN, '3.4 MB', 'ticked'), ('old-backup', '#e24b4a', '12.4 KB', '')]),
    ('CUSTOM', 1, [('Hosts nginx', GREEN, '640.2 KB', 'ticked')]),
])
toolbar(s, 236, 23, 756, ('318', '31', '12', '0'), 'merge')
s.rect(236, 49, 520, 22, fill='rgba(255,255,255,.03)', stroke=BORDER)
s.i_link(247, 60)
s.text(257, 63.5, '3 sources merged', fill=T65, size=10)
SRC = (('Syslog', M_SYSLOG, 66), ('plex', M_PLEX, 54), ('Hosts nginx', M_HOSTS, 92))
x = 356
for name, col, w in SRC:
    s.rect(x, 52.5, w, 15, fill='rgba(255,255,255,.04)', stroke=BORDER2)
    s.dot(x + 9, 60, col, r=2.8)
    s.text(x + 16, 63.5, name, fill=T85, size=9.5)
    s.i_x(x + w - 9, 60, T45, k=2)
    x += w + 5
s.rect(732, 52.5, 18, 15, fill='rgba(255,255,255,.04)')
s.i_x(741, 60, T45, k=2.2)
s.rect(236, 77, 520, 124, rx=2, fill=LOGBG)
for i, (k, text, lvl) in enumerate((
    (0, 'Nov 11 14:02:27 Raptor1 nginx: warning: upstream response is buffered', 'warning'),
    (2, '10.0.0.12 - - [11/Nov/2026:14:02:28 +0200] "GET /library HTTP/1.1" 200', ''),
    (1, 'Nov 11 14:02:29 Transcoder: session started for "Dune"', ''),
    (0, 'Nov 11 14:02:31 Raptor1 kernel: I/O error, dev sdc, sector 2048', 'error'),
    (1, 'Nov 11 14:02:32 Transcoder: read error on /media/Dune.mkv', 'error'),
    (2, '10.0.0.12 - - [11/Nov/2026:14:02:33 +0200] "GET /video HTTP/1.1" 500', ''),
    (0, 'Nov 11 14:02:36 Raptor1 webGUI: Successful login user root', 'success'),
)):
    name, col, _ = SRC[k]
    y = 94 + i * 16
    if i % 2 == 1:
        s.rect(237, y - 11.5, 518, 16, rx=0, fill='rgba(255,255,255,.03)', stroke=None)
    s.rect(244, y - 10.5, 74, 14, rx=2.5, fill=rgba(col, 0.16), stroke=rgba(col, 0.45))
    s.text(281, y - 0.5, name.upper(), fill=col, size=7.5, anchor='middle', weight='700', ls=0.2)
    s.text(326, y, text, fill=LEVEL[lvl], size=9.5, mono=True)
statusbar(s, 236, 207, 520, '2,416', False)
s.arrow(66, 247, 30, 190)
s.note(26, 258, 'In Merge a click ticks a source.')
s.note(754, 258, 'One list in time order. Each line starts with the log it came from.', anchor='end')
made.append(('06-merge.svg', s.out()))

s = Svg(262, 'Custom log paths, with a date placeholder')
s.rect(14, 14, 752, 24)
s.text(26, 30, 'Custom log paths', size=11, weight='600')
s.rect(678, 19, 58, 14, fill='rgba(255,140,0,.08)', stroke='rgba(255,140,0,.5)')
s.i_link(688, 26)
s.text(712, 29.3, 'Shared', fill=T65, size=8.5, anchor='middle')
s.tri(749, 26, 'up', T30)
s.panel(14, 38, 752, 170)
s.note_bar(26, 46, 596, [('Shared definitions.', YELLOW, '600'),
                         (' Custom log paths defined here apply across Tool page, Dashboard widget, Alerts and Backup.', T85)])
s.rect(26, 66, 290, 16, rx=2, fill='rgba(255,179,0,.10)', stroke=None)
s.rect(26, 66, 2.5, 16, rx=0, fill=YELLOW, stroke=None)
s.spans(36, 77.3, [('Allowed prefixes: ', T85), ('/var/log/', T65), (', ', T85), ('/mnt/user/', T65), (', ', T85), ('/mnt/cache/', T65), ('.', T85)],
        size=9.5, mono=False)
s.rect(26, 86, 400, 16, rx=2, fill='rgba(255,179,0,.10)', stroke=None)
s.rect(26, 86, 2.5, 16, rx=0, fill=YELLOW, stroke=None)
s.spans(36, 97.3, [('Date placeholders: ', T85), ('{YYYY}', T65), (', ', T85), ('{MM}', T65), (' and ', T85), ('{DD}', T65),
                   (" are replaced with today's date.", T85)], size=9.5, mono=False)
for i, (label, path) in enumerate((('App audit', '/mnt/user/appdata/app/audit.log'),
                                   ('Hosts nginx', '/var/log/hosts/{YYYY}/{MM}/{DD}/nginx/access.log'))):
    y = 110 + i * 32
    s.rect(26, y, 728, 28, fill='#1c1c1c', stroke='rgba(255,255,255,.07)')
    s.rect(34, y + 4, 172, 20, fill='#262626', stroke='rgba(255,255,255,.12)')
    s.text(42, y + 17.5, label, size=10)
    s.rect(214, y + 4, 502, 20, fill='#262626', stroke=BLUE if i == 1 else 'rgba(255,255,255,.12)')
    s.text(222, y + 17.5, path, size=10, mono=True)
    s.rect(724, y + 4, 22, 20, fill='none', stroke='rgba(255,255,255,.12)')
    s.i_trash(735, y + 14)
s.btn(26, 178, 70, '+ Add row', h=19)
s.arrow(330, 220, 330, 168)
s.note(26, 230, 'Today that row opens /var/log/hosts/2026/11/11/nginx/access.log. Tomorrow, the folder of the 12th.')
s.note(26, 248, 'The label is the name the log gets in every list.')
made.append(('07-custom-paths.svg', s.out()))

s = Svg(300, 'The backup calendar')
sec_header(s, 'Backup calendar', 'Download', 58)
s.panel(14, 38, 752, 226)
s.rect(300, 47, 20, 17, fill='rgba(255,255,255,.035)', stroke='rgba(255,255,255,.15)')
s.tri(310, 55.5, 'left', T65)
s.text(390, 59.5, 'November 2026', size=11, anchor='middle', weight='600')
s.rect(460, 47, 20, 17, fill='rgba(255,255,255,.035)', stroke='rgba(255,255,255,.15)')
s.tri(470, 55.5, 'right', T30)
PITCH = 104.67
for i, d in enumerate(('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')):
    s.text(76 + i * PITCH, 80, d, fill=T45, size=8.5, anchor='middle')
day = 1
for r in range(6):
    for c in range(7):
        if (r == 0 and c < 6) or day > 30:
            continue
        x, y = 26 + c * PITCH, 86 + r * 19
        has, sel, today = day <= 10, day == 10, day == 11
        if has:
            s.rect(x, y, 100, 16, fill='rgba(76,175,80,.32)' if sel else 'rgba(76,175,80,.12)',
                   stroke='rgba(76,175,80,.65)' if sel else 'rgba(76,175,80,.28)')
        s.text(x + 50, y + 11.8, str(day), fill='#ffffff' if sel else (T85 if has else (ACCENT if today else T18)), size=9.5, anchor='middle',
               weight='600' if (sel or today) else 'normal')
        day += 1
s.rect(26, 204, 8, 8, rx=2, fill='rgba(76,175,80,.40)', stroke=None)
s.text(38, 211.5, 'Backup available', fill=T45, size=9)
s.rect(142, 204, 8, 8, rx=2, fill=ACCENT, stroke=None)
s.text(154, 211.5, 'Today', fill=T45, size=9)
s.rect(26, 220, 728, 36, rx=6, fill='rgba(255,255,255,.035)')
s.text(38, 235, 'logsviewer-2026-11-10.zip', size=10.5, weight='600')
s.text(38, 248.5, 'System (2) + Docker (2) + VMs (1) + User Scripts (1) + Custom (1)   4.8 MB', fill=T45, size=9.5)
s.btn(676, 229, 66, 'Download', h=18, fill='rgba(76,175,80,.12)', stroke='rgba(76,175,80,.40)', color=GREEN, size=9)
s.arrow(709, 276, 709, 250)
s.note(26, 286, 'On disk the file is 2026-11-10.zip, with one folder per kind of log.')
s.note(754, 286, 'Click a green day, then Download.', anchor='end')
made.append(('08-backup-calendar.svg', s.out()))

s = Svg(350, 'An alert rule and what it leaves in the history')
s.rect(14, 14, 752, 226, rx=5, fill=PANEL)
s.rect(14, 14, 752, 28, rx=5)
s.check(26, 22.5, on=True)
s.rect(44, 18, 674, 20, fill='#1e1e1e', stroke='rgba(255,255,255,.14)')
s.text(52, 31.5, 'Failed Login', size=10.5, weight='600')
s.rect(726, 18, 22, 20, fill='rgba(255,255,255,.035)', stroke='rgba(255,255,255,.15)')
s.i_trash(737, 28)
s.text(26, 64.5, 'Pattern', fill=T45, size=10)
s.field(88, 51, 598, 'Failed password|authentication failure|Unsuccessful login', mono=True)
s.check(696, 55.5, on=True)
s.text(712, 64.5, 'Regex', fill=T45, size=9.5)
s.text(26, 90.5, 'Severity', fill=T45, size=10)
s.select(88, 77, 120, 'Warning')
s.text(226, 90.5, 'Cooldown', fill=T45, size=10)
s.select(286, 77, 150, '5 minutes')
s.text(26, 114.5, 'Tags', fill=T45, size=10)
s.select(26, 121, 728, '+ Add MITRE technique...', color=T65)
s.field(26, 145, 728, 'T1110, auth')
s.text(26, 185.5, 'Sources', fill=T45, size=10)
for x, y, name, on in ((88, 176.5, 'Syslog', True), (156, 176.5, 'Dmesg', False), (218, 176.5, 'GraphQL API', False),
                       (314, 176.5, 'Nginx Errors', False), (415, 176.5, 'PHP Log', False), (488, 176.5, 'Libvirt', False),
                       (88, 194.5, 'Hosts nginx', False), (184, 194.5, 'App audit', False), (268, 194.5, 'nightly_rsync', False),
                       (88, 217.5, 'Docker (all containers)', False)):
    s.check(x, y, on=on)
    s.text(x + 16, y + 9.5, name, fill=T85 if on else T65, size=10)
s.line(88, 211.5, 754, 211.5, stroke='rgba(255,255,255,.07)')

s.panel(14, 248, 752, 50)
s.text(26, 267, '2026-11-11 14:02:36', fill=T45, size=9.5, mono=True)
s.rect(144, 257, 58, 14, rx=2, fill='rgba(239,159,39,.14)', stroke=None)
s.text(173, 267, 'WARNING', fill=WARN, size=8, anchor='middle', weight='600', ls=0.3)
s.text(212, 267.5, 'Failed Login', size=10.5, weight='600')
s.rect(302, 257, 54, 14, rx=2, fill='rgba(244,125,66,.12)', stroke='rgba(244,125,66,.45)')
s.text(308, 267.2, 'T1110', fill=ACCENT, size=9, mono=True)
s.i_ext(347, 264)
s.line(366, 257, 366, 271, stroke='rgba(255,255,255,.12)')
s.text(374, 267.5, 'syslog', fill=T45, size=10)
s.rect(690, 255, 64, 18, fill='none', stroke=BORDER2)
s.i_mute(702, 263.5)
s.text(713, 267.5, 'Mute', fill=T85, size=9.5)
s.caret(741, 262.5)
s.text(26, 287, 'Nov 11 14:02:36 Raptor1 sshd[4121]: Failed password for root from 203.0.113.7 port 51122 ssh2', fill=T65, size=9.5, mono=True)
s.note(26, 320, 'A match raises an Unraid notification and adds a line to the history.')
s.note(26, 338, 'Mute silences that rule for 1 hour, 24 hours, 7 days, or permanently.')
s.arrow(452, 331, 698, 276)
made.append(('09-alert-rule.svg', s.out()))

os.makedirs(OUT, exist_ok=True)
for name, body in made:
    with open(os.path.join(OUT, name), 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)
    print(f'  {name:32s} {len(body.encode("utf-8")):6d} bytes')

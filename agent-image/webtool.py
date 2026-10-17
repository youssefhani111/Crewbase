#!/usr/bin/env python3
"""Free web tools for agents: search (DuckDuckGo) and read a page as plain text.

Usage:  python3 webtool.py search <base64 json {"query": ...}>
        python3 webtool.py fetch  <base64 json {"url": ...}>
Runs inside the agent's own computer, so it can only reach the public internet.
"""
import base64, html, json, re, sys, urllib.parse, urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
MAX_BYTES = 3_000_000
MAX_CHARS = 15_000


def get(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "en,ar;q=0.8"})
    with urllib.request.urlopen(req, timeout=25) as r:
        ctype = r.headers.get("content-type", "")
        raw = r.read(MAX_BYTES)
        charset = r.headers.get_content_charset() or "utf-8"
        return raw, ctype, charset, r.geturl()


class TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head", "template", "iframe"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "table", "ul", "ol"}

    def __init__(self):
        super().__init__()
        self.out, self.skip, self.title, self._in_title, self.links = [], 0, "", False, []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag == "title":
            self._in_title = True
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag == "a":
            href = dict(attrs).get("href")
            if href and href.startswith("http") and len(self.links) < 40:
                self.links.append(href)

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self.skip:
            self.out.append(data)


def search(query):
    raw, _, charset, _ = get("https://html.duckduckgo.com/html/", urllib.parse.urlencode({"q": query}).encode())
    page = raw.decode(charset, "replace")
    results = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]+class="result__a"|$)', page, re.S):
        href, title, rest = m.group(1), m.group(2), m.group(3)
        q = urllib.parse.urlparse(html.unescape(href)).query
        url = urllib.parse.parse_qs(q).get("uddg", [html.unescape(href)])[0]
        snip = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', rest, re.S)
        clean = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()
        results.append(f"{len(results) + 1}. {clean(title)}\n   {url}\n   {clean(snip.group(1) if snip else '')}")
        if len(results) >= 8:
            break
    return "\n".join(results) or "No results (the search engine may be rate-limiting; try different words or try again later)."


def fetch(url):
    if not re.match(r"^https?://", url):
        return "Only http(s) links are supported."
    raw, ctype, charset, final = get(url)
    if "pdf" in ctype:
        return f"{final} is a PDF. Download it with: curl -L -o file.pdf '{final}' and read it with: python3 -c \"...\" or pdftotext if installed."
    text = raw.decode(charset, "replace")
    if "html" in ctype or text.lstrip().startswith("<"):
        p = TextExtractor()
        p.feed(text)
        body = re.sub(r"[ \t\r\f\v]+", " ", "".join(p.out))
        body = re.sub(r"\n\s*\n+", "\n\n", body).strip()
        head = f"Title: {p.title.strip()}\nURL: {final}\n\n"
        return head + (body[:MAX_CHARS] + ("\n…[page cut]" if len(body) > MAX_CHARS else ""))
    return f"URL: {final}\n\n" + text[:MAX_CHARS]


if __name__ == "__main__":
    try:
        args = json.loads(base64.b64decode(sys.argv[2]).decode())
        print(search(args["query"]) if sys.argv[1] == "search" else fetch(args["url"]))
    except Exception as e:  # report errors as text so the agent can react
        print(f"Error: {e}")
        sys.exit(1)

import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
SEG = open('/Users/chrisallison/Desktop/Development/allison-web-iptv/.openclaw/tmp/ui2/seg.ts','rb').read()
CHANNELS = [{"num": i+1, "name": f"Guide Channel {i+1:02d}", "stream_id": 100+i, "stream_icon": "",
             "category_id": "1" if i % 2 == 0 else "2", "stream_type": "live"} for i in range(40)]
class H(BaseHTTPRequestHandler):
    def j(self, o):
        b=json.dumps(o).encode(); self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def raw(self, b, ct):
        self.send_response(200); self.send_header('Content-Type',ct); self.send_header('Content-Length',str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u=urlparse(self.path); q=parse_qs(u.query); a=q.get('action',[''])[0]
        if u.path.endswith('/player_api.php'):
            if a in ('','get_account_info'):
                return self.j({"user_info":{"username":"u","auth":1,"status":"Active","max_connections":"2","exp_date":"1819670400"}})
            if a=='get_live_categories':
                return self.j([{"category_id":"1","category_name":"News","parent_id":0},
                               {"category_id":"2","category_name":"Sports","parent_id":0}])
            if a=='get_live_streams':
                cat=q.get('category_id',[None])[0]
                return self.j([c for c in CHANNELS if not cat or c['category_id']==cat])
            if a=='get_short_epg':
                now=int(time.time())//1800*1800; items=[]
                for i in range(8):
                    items.append({"id":str(i),"epg_id":"1","title":f"Programme {i}",
                        "start_timestamp":str(now+i*1800),"stop_timestamp":str(now+(i+1)*1800),"description":""})
                return self.j({"epg_listings":items})
            return self.j({})
        if u.path.endswith('.m3u8'):
            seq=int(time.time())//6
            lines=["#EXTM3U","#EXT-X-VERSION:3","#EXT-X-TARGETDURATION:6",f"#EXT-X-MEDIA-SEQUENCE:{seq-3}"]
            for n in range(seq-3,seq): lines+=["#EXTINF:6.0,",f"seg{n}.ts"]
            return self.raw(("\n".join(lines)+"\n").encode(),'application/vnd.apple.mpegurl')
        if u.path.endswith('.ts'): return self.raw(SEG,'video/mp2t')
        self.send_response(404); self.send_header('Content-Length','0'); self.end_headers()
    def log_message(self,*a): pass
ThreadingHTTPServer(('0.0.0.0', 8089), H).serve_forever()

"""Pinned OpenClaw 2026.9.6 history-restore metadata, all other rows immutable."""
import base64
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3


def sha(raw): return hashlib.sha256(raw).hexdigest()
def millis(value): return int(datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()*1000)
def rows(path):
    with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        return {name: {'schema':schema,'rows':[dict(r) for r in db.execute('SELECT * FROM "'+name.replace('"','""')+'"')]}
                for name,schema in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table'")}
def fingerprint(raw, st):
    cfg=json.loads(raw)
    return {'hash':sha(raw),'bytes':len(raw),'mtimeMs':st['mtimeMs'],'ctimeMs':st['ctimeMs'],
            **{k:st[k] for k in ('dev','ino','mode','nlink','uid','gid')},
            'hasMeta':isinstance(cfg.get('meta'),dict),'gatewayMode':cfg.get('gateway',{}).get('mode')}
def stat_record(path):
    s=Path(path).stat()
    return {'mtimeMs':s.st_mtime_ns/1e6,'ctimeMs':s.st_ctime_ns/1e6,'dev':str(s.st_dev),'ino':str(s.st_ino),
            'mode':s.st_mode & 0o777,'nlink':s.st_nlink,'uid':s.st_uid,'gid':s.st_gid}
def exact_fingerprint(actual, expected, lo, hi):
    assert set(actual)==set(expected)|{'observedAt'}
    assert lo<=millis(actual['observedAt'])<=hi
    for k,v in expected.items():
        if k in ('mtimeMs','ctimeMs'): assert abs(actual[k]-v)<.001
        else: assert actual[k]==v, 'Config fingerprint '+k


def validate_metadata(evidence, session_key, scope, started_ms, finished_ms, config_path, config_bytes, owned_commands):
    evidence=Path(evidence); cfg=json.loads(config_bytes)
    before,after=rows(evidence/'before-state.sqlite'),rows(evidence/'after-state.sqlite')
    agents_before,agents_after=rows(evidence/'before-agent.sqlite'),rows(evidence/'after-agent.sqlite')
    assert set(agents_before)==set(agents_after)
    for table in agents_before:
        assert agents_before[table]['schema']==agents_after[table]['schema']
        if table!='session_key_contract':assert agents_before[table]==agents_after[table], 'Unexpected agent row change '+table
    ar,br=agents_before['session_key_contract']['rows'],agents_after['session_key_contract']['rows']
    if ar!=br:
        assert len(ar)==len(br)==1
        assert {k:v for k,v in ar[0].items() if k!='canonical_ready'}=={k:v for k,v in br[0].items() if k!='canonical_ready'}
        physical=json.loads((evidence/'agent-physical-before.json').read_text())
        assert json.loads(br[0]['canonical_ready'])==[1,'main',physical['dev']+':'+physical['ino'],physical['birthtimeNs']]
        assert ar[0]['canonical_ready'] is None, 'Only first native canonical receipt permitted'
    assert set(before)==set(after)
    allowed={'config_machine_state','config_health_entries','diagnostic_events','schema_meta','agent_databases'}
    for table in before:
        assert before[table]['schema']==after[table]['schema'], 'Schema changed'
        if table not in allowed: assert before[table]==after[table], 'Unrelated table changed: '+table
    registry_before={r['agent_id']:r for r in before['agent_databases']['rows']};registry_after={r['agent_id']:r for r in after['agent_databases']['rows']}
    assert set(registry_before)==set(registry_after)
    for key,a in registry_before.items():
        b=registry_after[key]
        if a==b:continue
        assert key=='main' and {k:v for k,v in a.items() if k not in ('last_seen_at','size_bytes')}=={k:v for k,v in b.items() if k not in ('last_seen_at','size_bytes')}
        assert started_ms<=b['last_seen_at']<=finished_ms
        physical=json.loads((evidence/'agent-physical-after.json').read_text())
        assert b['size_bytes']==physical['size']
    def table(name,stage): return (before if stage=='before' else after)[name]['rows']
    machinekey='tui.lastSession.'+sha(f'{scope}\nmain\nlocal embedded'.encode())[:32]
    a={r['state_key']:r for r in table('config_machine_state','before')};b={r['state_key']:r for r in table('config_machine_state','after')}
    assert {k:v for k,v in a.items() if k!=machinekey}=={k:v for k,v in b.items() if k!=machinekey}
    assert set(b[machinekey])=={'state_key','value_json','updated_at_ms'}
    assert json.loads(b[machinekey]['value_json'])==session_key and started_ms<=b[machinekey]['updated_at_ms']<=finished_ms
    a={r['config_path']:r for r in table('config_health_entries','before')};b={r['config_path']:r for r in table('config_health_entries','after')};key=str(config_path)
    assert set(a)==set(b) and {k:v for k,v in a.items() if k!=key}=={k:v for k,v in b.items() if k!=key}
    old,new=a[key],b[key];assert set(old)==set(new)=={'config_path','last_known_good_json','last_promoted_good_json','last_observed_suspicious_signature','updated_at_ms'}
    assert old['last_promoted_good_json']==new['last_promoted_good_json']
    good=json.loads(old['last_known_good_json']); stat=json.loads((evidence/'config-stat-before.json').read_text())
    current=fingerprint(config_bytes,stat); suspicious=[]
    if good['bytes']>=512 and len(config_bytes)<int(good['bytes']*.5): suspicious.append(f"size-drop-vs-last-good:{good['bytes']}->{len(config_bytes)}")
    if good['hasMeta'] and not current['hasMeta']:suspicious.append('missing-meta-vs-last-good')
    if good['gatewayMode'] and not current['gatewayMode']:suspicious.append('gateway-mode-missing-vs-last-good')
    if good['gatewayMode'] and set(cfg)=={'update'} and set(cfg['update'])=={'channel'} and isinstance(cfg['update']['channel'],str):suspicious.append('update-channel-only-root')
    signature=current['hash']+':'+','.join(suspicious) if suspicious else None
    if suspicious:
        assert new['last_known_good_json']==old['last_known_good_json']
        assert new['last_observed_suspicious_signature']==signature
    else:
        exact_fingerprint(json.loads(new['last_known_good_json']),current,0 if old==new else started_ms,finished_ms)
        assert new['last_observed_suspicious_signature'] is None
    if old!=new:assert started_ms<=new['updated_at_ms']<=finished_ms
    diagnostics_before=table('diagnostic_events','before'); diagnostics_after=table('diagnostic_events','after')
    bykey={r['event_key']:r for r in diagnostics_after}; assert all(bykey.get(r['event_key'])==r for r in diagnostics_before)
    prior_keys={r['event_key'] for r in diagnostics_before};added=[r for r in diagnostics_after if r['event_key'] not in prior_keys]
    expected_observations=1 if suspicious and old['last_observed_suspicious_signature']!=signature else 0
    assert len(added)==expected_observations
    commands={c['pid']:c for c in owned_commands if 'tui' in c['command']}
    for row in added:
        assert set(row)=={'scope','event_key','payload_json','created_at','sequence'} and row['scope']=='config-audit'
        v=json.loads(row['payload_json']);owned=commands[v['pid']]
        assert started_ms<=millis(v['ts'])<=finished_ms and row['created_at']==millis(v['ts'])
        assert re.fullmatch(re.escape(v['ts'])+r':config.observe:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}',row['event_key'])
        expected={'ts':v['ts'],'source':'config-io','event':'config.observe','phase':'read','configPath':key,
                  'pid':owned['pid'],'ppid':owned['supervisorPid'],'cwd':owned['cwd'],'argv':owned['nativeArgv'],'execArgv':[],
                  'exists':True,'valid':True,**current,'suspicious':suspicious,
                  'clobberedPath':None,'restoredFromBackup':False,'restoredBackupPath':None,'restoreErrorCode':None,'restoreErrorMessage':None}
        for prefix in ('lastKnownGood','backup'):
            for field in ('hash','bytes','mtimeMs','ctimeMs','dev','ino','mode','nlink','uid','gid','gatewayMode'):
                expected[prefix+field[0].upper()+field[1:]]=good[field]
        assert set(v)==set(expected)
        for k,value in expected.items():
            if k in ('mtimeMs','ctimeMs'):assert abs(v[k]-value)<.001
            else:assert v[k]==value, 'Observation field '+k
        assert row['sequence']==max([r['sequence'] for r in diagnostics_before] or [0])+1
    a={r['meta_key']:r for r in table('schema_meta','before')};b={r['meta_key']:r for r in table('schema_meta','after')}
    assert set(a)==set(b) and {k:v for k,v in a.items() if k!='state-migrations'}=={k:v for k,v in b.items() if k!='state-migrations'}
    previous,currentmeta=a['state-migrations'],b['state-migrations']
    assert {k:v for k,v in previous.items() if k not in ('app_version','updated_at')}=={k:v for k,v in currentmeta.items() if k not in ('app_version','updated_at')}
    parts=previous['app_version'].split('\n');actual=currentmeta['app_version'].split('\n');assert len(parts)==len(actual)==6
    assert actual[:3]==parts[:3]==['2026.9.6','3','2026-09-23T16:33:12.144Z'] and actual[5]==parts[5]
    cfgfp=base64.urlsafe_b64encode(hashlib.sha256(json.dumps(cfg,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).digest()).decode().rstrip('=')
    assert actual[3:5]==[cfgfp,cfgfp]
    if previous!=currentmeta:assert started_ms<=currentmeta['updated_at']<=finished_ms
    return {'passed':True,'allSchemasUnchanged':True,'allAgentHistoryRowsUnchanged':True,'onlyDerivedCanonicalReceiptAllowed':True,'unrelatedStateRowsUnchanged':True,
            'machineStateKey':machinekey,'suspiciousReasons':suspicious,'exactNewObserveRows':len(added),'configFingerprint':cfgfp,
            'allowedTables':sorted(allowed),'statComparisonToleranceMilliseconds':.001}

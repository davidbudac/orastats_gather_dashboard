#!/usr/bin/env python3
"""Build APEX installation and snapshot SQL without executing report JavaScript."""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_report(path):
    data = {}
    for script in re.findall(r'<script>([\s\S]*?)</script>', path.read_text()):
        match = re.fullmatch(r'D\.(\w+)\s*=\s*([\s\S]*?);\s*', script.strip())
        if not match:
            continue
        name, body = match.groups()
        try:
            if body.startswith('['):
                # The collector prints one complete JSON array per line.
                data[name] = [json.loads(row.rstrip(',')) for row in body[1:-1].splitlines() if row.strip()]
            else:
                data[name] = json.loads(body)
        except (ValueError, json.JSONDecodeError) as exc:
            print(f'Warning: dataset {name} was not collected: {exc}')
    if not isinstance(data.get('meta'), dict) or not data['meta'].get('generated'):
        raise ValueError('Not a dashboard report: missing valid metadata')
    return data


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def static_file(name, source, mime, file_id):
    raw = source.read_bytes().hex()
    lines = ['begin', 'wwv_flow_imp.g_varchar2_table := wwv_flow_imp.empty_varchar2_table;']
    for i, pos in enumerate(range(0, len(raw), 1800), 1):
        lines.append(f'wwv_flow_imp.g_varchar2_table({i}) := {literal(raw[pos:pos+1800])};')
    lines.append(f'''wwv_flow_imp_shared.create_app_static_file(
 p_id=>wwv_flow_imp.id({file_id}), p_file_name=>{literal(name)},
 p_mime_type=>{literal(mime)}, p_file_charset=>'utf-8',
 p_file_content=>wwv_flow_imp.varchar2_to_blob(wwv_flow_imp.g_varchar2_table));
end;
/''')
    return '\n'.join(lines)


def build(args):
    if not re.fullmatch(r'[A-Z][A-Z0-9_]*', args.schema):
        raise ValueError('Schema must be a simple uppercase Oracle identifier')
    data = read_report(args.report)
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    # ASCII escaping also makes chunk lengths independent of the database charset.
    payload = json.dumps(data, ensure_ascii=True, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    setup = f'''set define off verify off feedback off
whenever sqlerror exit sql.sqlcode rollback
begin
  apex_application_install.set_workspace({literal(args.workspace)});
  apex_application_install.set_schema({literal(args.schema)});
  apex_application_install.set_application_id({args.app_id});
end;
/
'''
    guard = f'''declare
  l_count number;
begin
  select count(*) into l_count from apex_applications
   where application_id={args.app_id}
     and (alias <> 'STATISTICS-OBSERVATORY' or workspace <> {literal(args.workspace)});
  if l_count > 0 then raise_application_error(-20001, 'Application ID belongs to another app'); end if;
end;
/
'''
    snapshot = f'''set define off verify off feedback off
whenever sqlerror exit sql.sqlcode rollback
declare
  l_payload clob;
begin
  dbms_lob.createtemporary(l_payload, true);
'''
    for pos in range(0, len(payload), 1600):
        chunk = payload[pos:pos+1600]
        snapshot += f'  dbms_lob.writeappend(l_payload, {len(chunk)}, {literal(chunk)});\n'
    snapshot += f'''  merge into {args.schema}.gd_report_snapshot d
  using (select 1 id from dual) s on (d.id=s.id)
  when matched then update set payload=l_payload, published_at=systimestamp
  when not matched then insert (id,payload,published_at) values (1,l_payload,systimestamp);
  dbms_lob.freetemporary(l_payload);
end;
/
commit;
'''
    (out / 'snapshot.sql').write_text(snapshot)
    application = setup + guard + '''begin
wwv_flow_imp.import_begin(
 p_version_yyyy_mm_dd=>'2026.04.07', p_release=>'26.2.0',
 p_default_workspace_id=>apex_util.find_security_group_id(''' + literal(args.workspace) + f'''),
 p_default_application_id=>{args.app_id}, p_default_id_offset=>0,
 p_default_owner=>{literal(args.schema)});
wwv_flow_imp.remove_flow(wwv_flow.g_flow_id);
end;
/
'''
    for name in ['application.sql', 'theme.sql', 'dashboard.sql', 'login.sql']:
        application += (ROOT / 'apex' / name).read_text() + '\n'
    assets = [
        ('report.js', ROOT / 'web/app.js', 'text/javascript'),
        ('report.css', ROOT / 'web/style.css', 'text/css'),
        ('observatory.js', ROOT / 'apex/observatory.js', 'text/javascript'),
        ('observatory.css', ROOT / 'apex/observatory.css', 'text/css'),
        ('observatory.svg', ROOT / 'apex/observatory.svg', 'image/svg+xml'),
    ]
    for i, (name, source, mime) in enumerate(assets):
        application += static_file(name, source, mime, 9100200+i) + '\n'
    version = int(hashlib.sha256(b''.join(source.read_bytes() for _, source, _ in assets)).hexdigest()[:10], 16)
    application = application.replace('p_files_version=>1,', f'p_files_version=>{version},')
    application += 'begin\nwwv_flow_imp.import_end;\ncommit;\nend;\n/\n'
    (out / 'application.sql').write_text(application)
    schema = f'''set define off
whenever sqlerror exit sql.sqlcode rollback
declare
  n number;
begin
  select count(*) into n from all_tables where owner={literal(args.schema)} and table_name='GD_REPORT_SNAPSHOT';
  if n=0 then
    execute immediate 'create table {args.schema}.gd_report_snapshot (
      id number primary key check (id=1), payload clob check (payload is json),
      published_at timestamp with time zone default systimestamp not null)';
  end if;
end;
/
'''
    (out / 'schema.sql').write_text(schema)
    (out / 'install.sql').write_text('@schema.sql\n@snapshot.sql\n@application.sql\nexit\n')
    print(f'Built app {args.app_id}: {data["meta"]["db"]}, collected {data["meta"]["generated"]}, {len(data.get("ops", []))} operations')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--workspace', default='MONITORING')
    parser.add_argument('--schema', default='MONITORING')
    parser.add_argument('--app-id', type=int, default=101)
    parser.add_argument('--output', type=Path, default=ROOT / 'apex/build')
    build(parser.parse_args())

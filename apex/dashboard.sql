begin
wwv_flow_imp_page.create_page(
 p_id=>1, p_name=>'Statistics Observatory', p_alias=>'OVERVIEW',
 p_step_title=>'Statistics Observatory',
 p_step_template=>2982503008768810240,
 p_page_template_options=>'#DEFAULT#',
 p_warn_on_unsaved_changes=>'N', p_protection_level=>'C',
 p_css_file_urls=>'#APP_FILES#report.css' || chr(10) || '#APP_FILES#observatory.css',
 p_javascript_code_onload=>q'!window.D = JSON.parse(document.getElementById('report-data').textContent);
const renderer = document.createElement('script');
renderer.src = '#APP_FILES#report.js';
renderer.onload = function () {
  const adapter = document.createElement('script');
  adapter.src = '#APP_FILES#observatory.js';
  document.body.appendChild(adapter);
};
renderer.onerror = function () { document.getElementById('app').textContent = 'Unable to load the dashboard. Please reload the page.'; };
document.body.appendChild(renderer);!'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(9100102), p_plug_name=>'Dashboard',
 p_static_id=>'observatory', p_plug_display_sequence=>10,
 p_plug_source_type=>'NATIVE_PLSQL',
 p_plug_source=>q'!declare
  l_payload clob;
  l_pos pls_integer := 1;
begin
  select payload into l_payload from gd_report_snapshot where id=1;
  sys.htp.p('<header class="obs-masthead"><div class="obs-brand">');
  sys.htp.p('<img src="#APP_FILES#observatory.svg" alt="" width="44" height="44"><div><span class="obs-eyebrow">Oracle APEX / Database operations</span><strong>Statistics Observatory</strong></div></div>');
  sys.htp.p('<div class="obs-actions"><button type="button" id="reload-snapshot">Reload snapshot</button><a href="' || apex_escape.html_attribute(v('LOGOUT_URL')) || '">Sign out</a></div></header>');
  sys.htp.p('<div class="obs-context"><span id="snapshot-source">Report snapshot</span><span>Read-only source collection</span><span id="snapshot-time"></span></div>');
  sys.htp.p('<div id="app"><p class="loading">Loading statistics dashboard...</p></div>');
  sys.htp.p('<script type="application/json" id="report-data">');
  while l_pos <= dbms_lob.getlength(l_payload) loop
    sys.htp.prn(dbms_lob.substr(l_payload, 8000, l_pos));
    l_pos := l_pos + 8000;
  end loop;
  sys.htp.p('</script>');
exception when no_data_found then
  sys.htp.p('<div id="app"><p class="loading">No report has been published yet.</p></div><script type="application/json" id="report-data">{}</script>');
end;!'
);
end;
/

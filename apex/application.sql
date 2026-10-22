-- APEX 26.2 application definition. Separate from the read-only collector.
-- build.py supplies the application/workspace settings and static files.
begin
wwv_imp_workspace.create_flow(
 p_id=>wwv_flow.g_flow_id,
 p_owner=>wwv_flow_application_install.get_schema,
 p_name=>'Statistics Observatory',
 p_alias=>'STATISTICS-OBSERVATORY',
 p_page_view_logging=>'YES',
 p_page_protection_enabled_y_n=>'Y',
 p_bookmark_checksum_function=>'SH512',
 p_compatibility_mode=>'26.1',
 p_flow_language=>'en',
 p_flow_language_derived_from=>'FLOW_PRIMARY_LANGUAGE',
 p_authentication_id=>wwv_flow_imp.id(9100101),
 p_logo_type=>'T', p_logo_text=>'Statistics Observatory',
 p_flow_version=>'1.0', p_flow_status=>'AVAILABLE',
 p_browser_cache=>'N', p_browser_frame=>'D', p_deep_linking=>'Y',
 p_rejoin_existing_sessions=>'N', p_file_storage=>'DB',
 p_files_version=>1, p_theme_id=>42,
 p_home_url=>'f?p=' || chr(38) || 'APP_ID.:1:' || chr(38) || 'APP_SESSION.',
 p_login_url=>'f?p=' || chr(38) || 'APP_ID.:9999:' || chr(38) || 'APP_SESSION.',
 p_theme_style_by_user_pref=>false, p_built_with_love=>false,
 p_navigation_list_position=>'TOP', p_nav_bar_type=>'LIST'
);
wwv_flow_imp_shared.create_authentication(
 p_id=>wwv_flow_imp.id(9100101),
 p_name=>'Oracle APEX Accounts', p_static_id=>'apex-accounts',
 p_scheme_type=>'NATIVE_APEX_ACCOUNTS', p_invalid_session_type=>'LOGIN',
 p_use_secure_cookie_yn=>'N', p_ras_mode=>0
);
end;
/

-- 0006: LDAP 直连认证源增加「搜索过滤器」（Redmine 风格），避免 (objectClass=*) 拉回组/OU/计算机等非用户对象
ALTER TABLE integration_settings ADD COLUMN ldap_filter TEXT;

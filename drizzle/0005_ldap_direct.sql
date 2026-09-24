-- 0005: LDAP 配置升级为 Redmine 风格直连认证源（名称/主机/端口/LDAPS），保留原网关字段作回退
ALTER TABLE integration_settings ADD COLUMN ldap_name TEXT;
ALTER TABLE integration_settings ADD COLUMN ldap_host TEXT;
ALTER TABLE integration_settings ADD COLUMN ldap_port INTEGER;
ALTER TABLE integration_settings ADD COLUMN ldap_ldaps INTEGER NOT NULL DEFAULT 0;

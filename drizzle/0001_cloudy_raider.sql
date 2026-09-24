CREATE TABLE `integration_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`ldap_gateway_url` text,
	`base_dn` text,
	`bind_dn` text,
	`encrypted_secret` text,
	`sync_interval_minutes` integer DEFAULT 30 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`email` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `role_assignments_role_idx` ON `role_assignments` (`role`);
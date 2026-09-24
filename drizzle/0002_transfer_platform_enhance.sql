ALTER TABLE `rules` ADD `approver_emails` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `assigned_approvers` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `detail` text;--> statement-breakpoint
CREATE TABLE `ldap_users` (
	`email` text PRIMARY KEY NOT NULL,
	`employee_id` text,
	`name` text NOT NULL,
	`department` text,
	`ou_path` text,
	`active` integer DEFAULT true NOT NULL,
	`last_synced_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ldap_users_department_idx` ON `ldap_users` (`department`);--> statement-breakpoint
CREATE INDEX `ldap_users_active_idx` ON `ldap_users` (`active`);

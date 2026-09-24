CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`extension` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`requester_id` text NOT NULL,
	`requester_email` text,
	`requester_name` text NOT NULL,
	`department` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_name` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_name` text NOT NULL,
	`object_key` text,
	`sha256` text,
	`decision_reason` text,
	`approver_id` text,
	`approver_email` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `applications_status_idx` ON `applications` (`status`);--> statement-breakpoint
CREATE INDEX `applications_created_at_idx` ON `applications` (`created_at`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text,
	`actor_display` text NOT NULL,
	`action` text NOT NULL,
	`object_id` text NOT NULL,
	`result` text NOT NULL,
	`previous_hash` text,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_object_idx` ON `audit_events` (`object_id`);--> statement-breakpoint
CREATE TABLE `ldap_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`actor_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`endpoint` text NOT NULL,
	`owner` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`priority` integer NOT NULL,
	`name` text NOT NULL,
	`extensions` text NOT NULL,
	`min_size_bytes` integer,
	`max_size_bytes` integer,
	`action` text NOT NULL,
	`scope` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rules_priority_idx` ON `rules` (`priority`);
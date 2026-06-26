CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_sub` text NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_owner_active` ON `notifications` (`owner_sub`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_owner_sub_channel_destination_unique` ON `notifications` (`owner_sub`,`channel`,`destination`);--> statement-breakpoint
CREATE INDEX `idx_findings_sale_id` ON `findings` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_hunts_owner_sub` ON `hunts` (`owner_sub`);--> statement-breakpoint
CREATE INDEX `idx_plan_items_sale_id` ON `plan_items` (`sale_id`);
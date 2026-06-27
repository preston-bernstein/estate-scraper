CREATE TABLE `sale_outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` text NOT NULL,
	`owner_sub` text NOT NULL,
	`attended` integer NOT NULL,
	`outcome` text NOT NULL,
	`notes` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`sale_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sale_outcomes_sale_owner` ON `sale_outcomes` (`sale_id`,`owner_sub`);--> statement-breakpoint
ALTER TABLE `findings` ADD `image_position_pct` real;--> statement-breakpoint
ALTER TABLE `findings` ADD `confidence` text;--> statement-breakpoint
ALTER TABLE `sales` ADD `image_count` integer;--> statement-breakpoint
ALTER TABLE `sales` ADD `images_analyzed` integer;--> statement-breakpoint
ALTER TABLE `sales` ADD `analysis_phase` text;--> statement-breakpoint
ALTER TABLE `sales` ADD `oracle_score` real;--> statement-breakpoint
ALTER TABLE `sales` ADD `oracle_verdict` text;--> statement-breakpoint
ALTER TABLE `sales` ADD `oracle_should_attend` integer;--> statement-breakpoint
ALTER TABLE `sales` ADD `oracle_top_items` text;
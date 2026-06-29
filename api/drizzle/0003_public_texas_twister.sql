CREATE TABLE `finding_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` integer NOT NULL,
	`sale_id` text NOT NULL,
	`maker` text,
	`maker_raw` text,
	`category` text NOT NULL,
	`era` text,
	`desirability` text NOT NULL,
	`matched_lexicon` text NOT NULL,
	`item_desc` text NOT NULL,
	`source` text NOT NULL,
	`id_confidence` text NOT NULL,
	`vlm_model` text,
	`prompt_version` text,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`sale_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_finding_items_finding_id` ON `finding_items` (`finding_id`);--> statement-breakpoint
CREATE INDEX `idx_finding_items_sale_id` ON `finding_items` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_finding_items_maker` ON `finding_items` (`maker`);--> statement-breakpoint
CREATE INDEX `idx_finding_items_category` ON `finding_items` (`category`);--> statement-breakpoint
CREATE TABLE `images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` text NOT NULL,
	`image_url` text NOT NULL,
	`thumbnail_path` text,
	`embedding` blob,
	`embed_model` text,
	`embed_dim` integer,
	`phash` text,
	`is_boilerplate` integer DEFAULT false NOT NULL,
	`position_pct` real,
	`analyzed_at` text NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`sale_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_images_sale_id` ON `images` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_images_phash` ON `images` (`phash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_images_sale_image_url` ON `images` (`sale_id`,`image_url`);--> statement-breakpoint
ALTER TABLE `findings` ADD `image_id` integer REFERENCES images(id);--> statement-breakpoint
ALTER TABLE `findings` ADD `vlm_model` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `prompt_version` text;--> statement-breakpoint
CREATE INDEX `idx_findings_image_id` ON `findings` (`image_id`);
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "title_type" AS ENUM ('MOVIE', 'SERIES');

-- CreateEnum
CREATE TYPE "content_status" AS ENUM ('PENDING', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "asset_status" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "moderation_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "upload_session_status" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'USER',
    "email_verified" TIMESTAMP(3),
    "is_suspended" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "is_kids" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT NOT NULL DEFAULT 'en',
    "maturity" INTEGER NOT NULL DEFAULT 100,
    "autoplay_next" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "titles" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "title_type" NOT NULL DEFAULT 'MOVIE',
    "name" TEXT NOT NULL,
    "synopsis" TEXT NOT NULL DEFAULT '',
    "release_year" INTEGER NOT NULL,
    "rating" TEXT NOT NULL DEFAULT 'PG-13',
    "runtime_minutes" INTEGER,
    "poster_url" TEXT,
    "backdrop_url" TEXT,
    "trailer_url" TEXT,
    "hero_landscape_url" TEXT,
    "maturity_rating" TEXT NOT NULL DEFAULT 'PG-13',
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "is_original" BOOLEAN NOT NULL DEFAULT false,
    "original_language" TEXT NOT NULL DEFAULT 'en',
    "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cast" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "directors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "content_status" NOT NULL DEFAULT 'PENDING',
    "view_count" BIGINT NOT NULL DEFAULT 0,
    "like_count" BIGINT NOT NULL DEFAULT 0,
    "moderation_status" "moderation_status" NOT NULL DEFAULT 'PENDING',
    "publishedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" UUID NOT NULL,
    "title_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT,
    "overview" TEXT NOT NULL DEFAULT '',
    "aired_from" TIMESTAMP(3),
    "aired_to" TIMESTAMP(3),
    "poster_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episodes" (
    "id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "overview" TEXT NOT NULL DEFAULT '',
    "runtime_minutes" INTEGER,
    "still_url" TEXT,
    "air_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_assets" (
    "id" UUID NOT NULL,
    "episode_id" UUID,
    "title_id" UUID,
    "status" "asset_status" NOT NULL DEFAULT 'UPLOADING',
    "source_key" TEXT NOT NULL,
    "source_etag" TEXT,
    "source_size_bytes" BIGINT NOT NULL,
    "source_mime" TEXT,
    "container" TEXT,
    "duration_seconds" DOUBLE PRECISION,
    "source_width" INTEGER,
    "source_height" INTEGER,
    "thumbnail_sprite_key" TEXT,
    "thumbnail_vtt_key" TEXT,
    "master_playlist_key" TEXT,
    "processing_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "video_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_renditions" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "video_bitrate_kbps" INTEGER NOT NULL,
    "audio_bitrate_kbps" INTEGER NOT NULL,
    "codec" TEXT NOT NULL DEFAULT 'h264',
    "playlist_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_renditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_tracks" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "vtt_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subtitle_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "total_bytes" BIGINT NOT NULL,
    "chunk_size" INTEGER NOT NULL,
    "received_bytes" BIGINT NOT NULL DEFAULT 0,
    "next_offset" BIGINT NOT NULL DEFAULT 0,
    "status" "upload_session_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_progress" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "title_id" UUID NOT NULL,
    "episode_id" UUID,
    "position_seconds" INTEGER NOT NULL DEFAULT 0,
    "duration_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percent_watched" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_ingestion" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "success_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "errors_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_ingestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_items" (
    "id" UUID NOT NULL,
    "title_id" TEXT NOT NULL,
    "status" "moderation_status" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "profiles_user_id_idx" ON "profiles"("user_id");

-- CreateIndex
CREATE INDEX "profiles_is_kids_idx" ON "profiles"("is_kids");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_user_id_name_key" ON "profiles"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_expires_at_idx" ON "password_reset_tokens"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "titles_slug_key" ON "titles"("slug");

-- CreateIndex
CREATE INDEX "titles_type_idx" ON "titles"("type");

-- CreateIndex
CREATE INDEX "titles_release_year_idx" ON "titles"("release_year");

-- CreateIndex
CREATE INDEX "titles_rating_idx" ON "titles"("rating");

-- CreateIndex
CREATE INDEX "titles_is_featured_idx" ON "titles"("is_featured");

-- CreateIndex
CREATE INDEX "titles_view_count_idx" ON "titles"("view_count");

-- CreateIndex
CREATE INDEX "titles_moderation_status_idx" ON "titles"("moderation_status");

-- CreateIndex
CREATE INDEX "seasons_title_id_idx" ON "seasons"("title_id");

-- CreateIndex
CREATE UNIQUE INDEX "seasons_title_id_number_key" ON "seasons"("title_id", "number");

-- CreateIndex
CREATE INDEX "episodes_season_id_idx" ON "episodes"("season_id");

-- CreateIndex
CREATE UNIQUE INDEX "episodes_season_id_number_key" ON "episodes"("season_id", "number");

-- CreateIndex
CREATE INDEX "video_assets_title_id_idx" ON "video_assets"("title_id");

-- CreateIndex
CREATE INDEX "video_assets_episode_id_idx" ON "video_assets"("episode_id");

-- CreateIndex
CREATE INDEX "video_assets_status_idx" ON "video_assets"("status");

-- CreateIndex
CREATE INDEX "video_assets_uploaded_by_id_idx" ON "video_assets"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "video_renditions_asset_id_idx" ON "video_renditions"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_renditions_asset_id_label_key" ON "video_renditions"("asset_id", "label");

-- CreateIndex
CREATE INDEX "subtitle_tracks_asset_id_idx" ON "subtitle_tracks"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "subtitle_tracks_asset_id_language_key" ON "subtitle_tracks"("asset_id", "language");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_asset_id_key" ON "upload_sessions"("asset_id");

-- CreateIndex
CREATE INDEX "upload_sessions_asset_id_idx" ON "upload_sessions"("asset_id");

-- CreateIndex
CREATE INDEX "watch_progress_profile_id_updated_at_idx" ON "watch_progress"("profile_id", "updated_at");

-- CreateIndex
CREATE INDEX "watch_progress_title_id_idx" ON "watch_progress"("title_id");

-- CreateIndex
CREATE UNIQUE INDEX "watch_progress_profile_id_title_id_episode_id_key" ON "watch_progress"("profile_id", "title_id", "episode_id");

-- CreateIndex
CREATE INDEX "watchlist_user_id_idx" ON "watchlist"("user_id");

-- CreateIndex
CREATE INDEX "watchlist_title_id_idx" ON "watchlist"("title_id");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_user_id_title_id_key" ON "watchlist"("user_id", "title_id");

-- CreateIndex
CREATE INDEX "bulk_ingestion_user_id_idx" ON "bulk_ingestion"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_items_title_id_key" ON "moderation_items"("title_id");

-- CreateIndex
CREATE INDEX "moderation_items_status_idx" ON "moderation_items"("status");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_title_id_fkey" FOREIGN KEY ("title_id") REFERENCES "titles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_assets" ADD CONSTRAINT "video_assets_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_assets" ADD CONSTRAINT "video_assets_title_id_fkey" FOREIGN KEY ("title_id") REFERENCES "titles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_renditions" ADD CONSTRAINT "video_renditions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtitle_tracks" ADD CONSTRAINT "subtitle_tracks_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_title_id_fkey" FOREIGN KEY ("title_id") REFERENCES "titles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_title_id_fkey" FOREIGN KEY ("title_id") REFERENCES "titles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_ingestion" ADD CONSTRAINT "bulk_ingestion_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_items" ADD CONSTRAINT "moderation_items_title_id_fkey" FOREIGN KEY ("title_id") REFERENCES "titles"("id") ON DELETE CASCADE ON UPDATE CASCADE;


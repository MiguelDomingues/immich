import { Inject, Injectable, UnsupportedMediaTypeException } from '@nestjs/common';
import {
  AudioCodec,
  Colorspace,
  ImageFormat,
  TranscodeHWAccel,
  TranscodePolicy,
  TranscodeTarget,
  VideoCodec,
} from 'src/config';
import { GeneratedImageType, StorageCore, StorageFolder } from 'src/cores/storage.core';
import { SystemConfigCore } from 'src/cores/system-config.core';
import { SystemConfigFFmpegDto, SystemConfigImageDto } from 'src/dtos/system-config.dto';
import { AssetEntity, AssetType } from 'src/entities/asset.entity';
import { AssetPathType } from 'src/entities/move.entity';
import { IAssetRepository, WithoutProperty } from 'src/interfaces/asset.interface';
import { ICryptoRepository } from 'src/interfaces/crypto.interface';
import {
  IBaseJob,
  IEntityJob,
  IJobRepository,
  JOBS_ASSET_PAGINATION_SIZE,
  JobItem,
  JobName,
  JobStatus,
  QueueName,
} from 'src/interfaces/job.interface';
import { ILoggerRepository } from 'src/interfaces/logger.interface';
import {
  AudioStreamInfo,
  GenerateImageOptions,
  IMediaRepository,
  VideoCodecHWConfig,
  VideoStreamInfo,
} from 'src/interfaces/media.interface';
import { IMoveRepository } from 'src/interfaces/move.interface';
import { IPersonRepository } from 'src/interfaces/person.interface';
import { IStorageRepository } from 'src/interfaces/storage.interface';
import { ISystemMetadataRepository } from 'src/interfaces/system-metadata.interface';
import {
  AV1Config,
  H264Config,
  HEVCConfig,
  NvencHwDecodeConfig,
  NvencSwDecodeConfig,
  QsvHwDecodeConfig,
  QsvSwDecodeConfig,
  RkmppHwDecodeConfig,
  RkmppSwDecodeConfig,
  ThumbnailConfig,
  VAAPIConfig,
  VP9Config,
} from 'src/utils/media';
import { mimeTypes } from 'src/utils/mime-types';
import { usePagination } from 'src/utils/pagination';

@Injectable()
export class MediaService {
  private configCore: SystemConfigCore;
  private storageCore: StorageCore;
  private openCL: boolean | null = null;
  private devices: string[] | null = null;

  constructor(
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(IPersonRepository) private personRepository: IPersonRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
    @Inject(IMediaRepository) private mediaRepository: IMediaRepository,
    @Inject(IStorageRepository) private storageRepository: IStorageRepository,
    @Inject(ISystemMetadataRepository) systemMetadataRepository: ISystemMetadataRepository,
    @Inject(IMoveRepository) moveRepository: IMoveRepository,
    @Inject(ICryptoRepository) cryptoRepository: ICryptoRepository,
    @Inject(ILoggerRepository) private logger: ILoggerRepository,
  ) {
    this.logger.setContext(MediaService.name);
    this.configCore = SystemConfigCore.create(systemMetadataRepository, this.logger);
    this.storageCore = StorageCore.create(
      assetRepository,
      cryptoRepository,
      moveRepository,
      personRepository,
      storageRepository,
      systemMetadataRepository,
      this.logger,
    );
  }

  async handleQueueGenerateThumbnails({ force }: IBaseJob): Promise<JobStatus> {
    const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) => {
      return force
        ? this.assetRepository.getAll(pagination, { isVisible: true })
        : this.assetRepository.getWithout(pagination, WithoutProperty.THUMBNAIL);
    });

    for await (const assets of assetPagination) {
      const jobs: JobItem[] = [];

      for (const asset of assets) {
        if (!asset.previewPath || !asset.thumbnailPath || force) {
          jobs.push({ name: JobName.GENERATE_THUMBNAILS, data: { id: asset.id } });
          continue;
        }

        if (!asset.thumbhash) {
          jobs.push({ name: JobName.GENERATE_THUMBHASH, data: { id: asset.id } });
        }
      }

      await this.jobRepository.queueAll(jobs);
    }

    const jobs: JobItem[] = [];
    const personPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) =>
      this.personRepository.getAll(pagination, { where: force ? undefined : { thumbnailPath: '' } }),
    );

    for await (const people of personPagination) {
      for (const person of people) {
        if (!person.faceAssetId) {
          const face = await this.personRepository.getRandomFace(person.id);
          if (!face) {
            continue;
          }

          await this.personRepository.update({ id: person.id, faceAssetId: face.id });
        }

        jobs.push({ name: JobName.GENERATE_PERSON_THUMBNAIL, data: { id: person.id } });
      }
    }

    await this.jobRepository.queueAll(jobs);

    return JobStatus.SUCCESS;
  }

  async handleQueueMigration(): Promise<JobStatus> {
    const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) =>
      this.assetRepository.getAll(pagination),
    );

    const { active, waiting } = await this.jobRepository.getJobCounts(QueueName.MIGRATION);
    if (active === 1 && waiting === 0) {
      await this.storageCore.removeEmptyDirs(StorageFolder.THUMBNAILS);
      await this.storageCore.removeEmptyDirs(StorageFolder.ENCODED_VIDEO);
    }

    for await (const assets of assetPagination) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.MIGRATE_ASSET, data: { id: asset.id } })),
      );
    }

    const personPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) =>
      this.personRepository.getAll(pagination),
    );

    for await (const people of personPagination) {
      await this.jobRepository.queueAll(
        people.map((person) => ({ name: JobName.MIGRATE_PERSON, data: { id: person.id } })),
      );
    }

    return JobStatus.SUCCESS;
  }

  async handleAssetMigration({ id }: IEntityJob): Promise<JobStatus> {
    const { image } = await this.configCore.getConfig();
    const [asset] = await this.assetRepository.getByIds([id]);
    if (!asset) {
      return JobStatus.FAILED;
    }

    await this.storageCore.moveAssetImage(asset, AssetPathType.PREVIEW, image.previewFormat);
    await this.storageCore.moveAssetImage(asset, AssetPathType.THUMBNAIL, image.thumbnailFormat);
    await this.storageCore.moveAssetVideo(asset);

    return JobStatus.SUCCESS;
  }

  async handleGenerateThumbnails({ id }: IEntityJob): Promise<JobStatus> {
    const [{ image }, [asset]] = await Promise.all([
      this.configCore.getConfig(),
      this.assetRepository.getByIds([id], { exifInfo: true }),
    ]);
    if (!asset) {
      return JobStatus.FAILED;
    }

    if (!asset.isVisible) {
      return JobStatus.SKIPPED;
    }

    let previewPath;
    let thumbnailPath;
    if (asset.type === AssetType.IMAGE) {
      const { preview, thumbnail } = await this.generateImageThumbnails(asset);
      previewPath = preview.path;
      thumbnailPath = thumbnail.path;
    } else if (asset.type === AssetType.VIDEO) {
      previewPath = await this.generateVideoThumbnail(asset, AssetPathType.PREVIEW, image.previewFormat);
      thumbnailPath = await this.generateVideoThumbnail(asset, AssetPathType.THUMBNAIL, image.thumbnailFormat);
    } else {
      return JobStatus.SKIPPED;
    }

    await this.assetRepository.update({ id: asset.id, previewPath, thumbnailPath });

    if (asset.previewPath && asset.previewPath !== previewPath) {
      this.logger.debug(`Deleting old preview for asset ${asset.id}`);
      await this.storageRepository.unlink(asset.previewPath);
    }

    if (asset.thumbnailPath && asset.thumbnailPath !== thumbnailPath) {
      this.logger.debug(`Deleting old thumbnail for asset ${asset.id}`);
      await this.storageRepository.unlink(asset.thumbnailPath);
    }

    return JobStatus.SUCCESS;
  }

  private async generateImageThumbnails(asset: AssetEntity) {
    const { image } = await this.configCore.getConfig();
    const imageOptions = this.getImageOptions(asset, image);
    this.storageCore.ensureFolders(imageOptions.preview.path);

    const shouldExtract = image.extractEmbedded && mimeTypes.isRaw(asset.originalPath);
    const extractedPath = StorageCore.getTempPathInDir(imageOptions.preview.path);
    const didExtract = shouldExtract && (await this.mediaRepository.extract(asset.originalPath, extractedPath));

    try {
      const useExtracted = didExtract && (await this.shouldUseExtractedImage(extractedPath, image.previewSize));
      const outputPath = useExtracted ? extractedPath : asset.originalPath;
      await this.mediaRepository.generateThumbnail(outputPath, imageOptions);
    } finally {
      if (didExtract) {
        await this.storageRepository.unlink(extractedPath);
      }
    }

    return imageOptions;
  }

  private getImageOptions(asset: AssetEntity, image: SystemConfigImageDto): GenerateImageOptions {
    const previewPath = StorageCore.getImagePath(asset, AssetPathType.PREVIEW, image.previewFormat);
    const thumbnailPath = StorageCore.getImagePath(asset, AssetPathType.THUMBNAIL, image.thumbnailFormat);
    const colorspace = this.isSRGB(asset) ? Colorspace.SRGB : image.colorspace;
    return {
      colorspace,
      preview: {
        format: image.previewFormat,
        path: previewPath,
        quality: image.quality,
        size: image.previewSize,
      },
      thumbnail: {
        format: image.thumbnailFormat,
        path: thumbnailPath,
        quality: image.quality,
        size: image.thumbnailSize,
      },
    };
  }

  private async generateVideoThumbnail(asset: AssetEntity, type: GeneratedImageType, format: ImageFormat) {
    const { image, ffmpeg } = await this.configCore.getConfig();
    const path = StorageCore.getImagePath(asset, type, format);
    const size = type === AssetPathType.PREVIEW ? image.previewSize : image.thumbnailSize;
    this.storageCore.ensureFolders(path);

    const { audioStreams, videoStreams } = await this.mediaRepository.probe(asset.originalPath);
    const mainVideoStream = this.getMainStream(videoStreams);
    if (!mainVideoStream) {
      this.logger.warn(`Skipped thumbnail generation for asset ${asset.id}: no video streams found`);
      return;
    }
    const mainAudioStream = this.getMainStream(audioStreams);
    const config = { ...ffmpeg, targetResolution: size.toString() };
    const options = new ThumbnailConfig(config).getOptions(TranscodeTarget.VIDEO, mainVideoStream, mainAudioStream);
    await this.mediaRepository.transcode(asset.originalPath, path, options);

    this.logger.log(
      `Successfully generated ${format.toUpperCase()} ${asset.type.toLowerCase()} ${type} for asset ${asset.id}`,
    );
    return path;
  }

  async handleGenerateThumbhash({ id }: IEntityJob): Promise<JobStatus> {
    const [asset] = await this.assetRepository.getByIds([id]);
    if (!asset) {
      return JobStatus.FAILED;
    }

    if (!asset.isVisible) {
      return JobStatus.SKIPPED;
    }

    if (!asset.previewPath) {
      return JobStatus.FAILED;
    }

    const thumbhash = await this.mediaRepository.generateThumbhash(asset.previewPath);
    await this.assetRepository.update({ id: asset.id, thumbhash });

    return JobStatus.SUCCESS;
  }

  async handleQueueVideoConversion(job: IBaseJob): Promise<JobStatus> {
    const { force } = job;

    const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) => {
      return force
        ? this.assetRepository.getAll(pagination, { type: AssetType.VIDEO })
        : this.assetRepository.getWithout(pagination, WithoutProperty.ENCODED_VIDEO);
    });

    for await (const assets of assetPagination) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.VIDEO_CONVERSION, data: { id: asset.id } })),
      );
    }

    return JobStatus.SUCCESS;
  }

  async handleVideoConversion({ id }: IEntityJob): Promise<JobStatus> {
    const [asset] = await this.assetRepository.getByIds([id]);
    if (!asset || asset.type !== AssetType.VIDEO) {
      return JobStatus.FAILED;
    }

    const input = asset.originalPath;
    const output = StorageCore.getEncodedVideoPath(asset);
    this.storageCore.ensureFolders(output);

    const { videoStreams, audioStreams, format } = await this.mediaRepository.probe(input);
    const mainVideoStream = this.getMainStream(videoStreams);
    const mainAudioStream = this.getMainStream(audioStreams);
    const containerExtension = format.formatName;
    if (!mainVideoStream || !containerExtension) {
      return JobStatus.FAILED;
    }

    if (!mainVideoStream.height || !mainVideoStream.width) {
      this.logger.warn(`Skipped transcoding for asset ${asset.id}: no video streams found`);
      return JobStatus.FAILED;
    }

    const { ffmpeg: config } = await this.configCore.getConfig();
    const target = this.getTranscodeTarget(config, mainVideoStream, mainAudioStream);
    if (target === TranscodeTarget.NONE) {
      if (asset.encodedVideoPath) {
        this.logger.log(`Transcoded video exists for asset ${asset.id}, but is no longer required. Deleting...`);
        await this.jobRepository.queue({ name: JobName.DELETE_FILES, data: { files: [asset.encodedVideoPath] } });
        await this.assetRepository.update({ id: asset.id, encodedVideoPath: null });
      }

      return JobStatus.SKIPPED;
    }

    let transcodeOptions;
    try {
      transcodeOptions = await this.getCodecConfig(config).then((c) =>
        c.getOptions(target, mainVideoStream, mainAudioStream),
      );
    } catch (error) {
      this.logger.error(`An error occurred while configuring transcoding options: ${error}`);
      return JobStatus.FAILED;
    }

    this.logger.log(`Started encoding video ${asset.id} ${JSON.stringify(transcodeOptions)}`);
    try {
      await this.mediaRepository.transcode(input, output, transcodeOptions);
    } catch (error) {
      this.logger.error(error);
      if (config.accel !== TranscodeHWAccel.DISABLED) {
        this.logger.error(
          `Error occurred during transcoding. Retrying with ${config.accel.toUpperCase()} acceleration disabled.`,
        );
      }
      transcodeOptions = await this.getCodecConfig({ ...config, accel: TranscodeHWAccel.DISABLED }).then((c) =>
        c.getOptions(target, mainVideoStream, mainAudioStream),
      );
      await this.mediaRepository.transcode(input, output, transcodeOptions);
    }

    this.logger.log(`Successfully encoded ${asset.id}`);

    await this.assetRepository.update({ id: asset.id, encodedVideoPath: output });

    return JobStatus.SUCCESS;
  }

  private getMainStream<T extends VideoStreamInfo | AudioStreamInfo>(streams: T[]): T {
    return streams.sort((stream1, stream2) => stream2.frameCount - stream1.frameCount)[0];
  }

  private getTranscodeTarget(
    config: SystemConfigFFmpegDto,
    videoStream: VideoStreamInfo | null,
    audioStream: AudioStreamInfo | null,
  ): TranscodeTarget {
    if (videoStream == null && audioStream == null) {
      return TranscodeTarget.NONE;
    }

    const isAudioTranscodeRequired = this.isAudioTranscodeRequired(config, audioStream);
    const isVideoTranscodeRequired = this.isVideoTranscodeRequired(config, videoStream);

    if (isAudioTranscodeRequired && isVideoTranscodeRequired) {
      return TranscodeTarget.ALL;
    }

    if (isAudioTranscodeRequired) {
      return TranscodeTarget.AUDIO;
    }

    if (isVideoTranscodeRequired) {
      return TranscodeTarget.VIDEO;
    }

    return TranscodeTarget.NONE;
  }

  private isAudioTranscodeRequired(ffmpegConfig: SystemConfigFFmpegDto, stream: AudioStreamInfo | null): boolean {
    if (stream == null) {
      return false;
    }

    switch (ffmpegConfig.transcode) {
      case TranscodePolicy.DISABLED: {
        return false;
      }
      case TranscodePolicy.ALL: {
        return true;
      }
      case TranscodePolicy.REQUIRED:
      case TranscodePolicy.OPTIMAL:
      case TranscodePolicy.BITRATE: {
        return !ffmpegConfig.acceptedAudioCodecs.includes(stream.codecName as AudioCodec);
      }
      default: {
        throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
      }
    }
  }

  private isVideoTranscodeRequired(ffmpegConfig: SystemConfigFFmpegDto, stream: VideoStreamInfo | null): boolean {
    if (stream == null) {
      return false;
    }

    const scalingEnabled = ffmpegConfig.targetResolution !== 'original';
    const targetRes = Number.parseInt(ffmpegConfig.targetResolution);
    const isLargerThanTargetRes = scalingEnabled && Math.min(stream.height, stream.width) > targetRes;
    const isLargerThanTargetBitrate = stream.bitrate > this.parseBitrateToBps(ffmpegConfig.maxBitrate);

    const isTargetVideoCodec = ffmpegConfig.acceptedVideoCodecs.includes(stream.codecName as VideoCodec);
    const isRequired = !isTargetVideoCodec || stream.isHDR;

    switch (ffmpegConfig.transcode) {
      case TranscodePolicy.DISABLED: {
        return false;
      }
      case TranscodePolicy.ALL: {
        return true;
      }
      case TranscodePolicy.REQUIRED: {
        return isRequired;
      }
      case TranscodePolicy.OPTIMAL: {
        return isRequired || isLargerThanTargetRes;
      }
      case TranscodePolicy.BITRATE: {
        return isRequired || isLargerThanTargetBitrate;
      }
      default: {
        throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
      }
    }
  }

  async getCodecConfig(config: SystemConfigFFmpegDto) {
    if (config.accel === TranscodeHWAccel.DISABLED) {
      return this.getSWCodecConfig(config);
    }
    return this.getHWCodecConfig(config);
  }

  private getSWCodecConfig(config: SystemConfigFFmpegDto) {
    switch (config.targetVideoCodec) {
      case VideoCodec.H264: {
        return new H264Config(config);
      }
      case VideoCodec.HEVC: {
        return new HEVCConfig(config);
      }
      case VideoCodec.VP9: {
        return new VP9Config(config);
      }
      case VideoCodec.AV1: {
        return new AV1Config(config);
      }
      default: {
        throw new UnsupportedMediaTypeException(`Codec '${config.targetVideoCodec}' is unsupported`);
      }
    }
  }

  private async getHWCodecConfig(config: SystemConfigFFmpegDto) {
    let handler: VideoCodecHWConfig;
    switch (config.accel) {
      case TranscodeHWAccel.NVENC: {
        handler = config.accelDecode ? new NvencHwDecodeConfig(config) : new NvencSwDecodeConfig(config);
        break;
      }
      case TranscodeHWAccel.QSV: {
        handler = config.accelDecode
          ? new QsvHwDecodeConfig(config, await this.getDevices())
          : new QsvSwDecodeConfig(config, await this.getDevices());
        break;
      }
      case TranscodeHWAccel.VAAPI: {
        handler = new VAAPIConfig(config, await this.getDevices());
        break;
      }
      case TranscodeHWAccel.RKMPP: {
        handler =
          config.accelDecode && (await this.hasOpenCL())
            ? new RkmppHwDecodeConfig(config, await this.getDevices())
            : new RkmppSwDecodeConfig(config, await this.getDevices());
        break;
      }
      default: {
        throw new UnsupportedMediaTypeException(`${config.accel.toUpperCase()} acceleration is unsupported`);
      }
    }
    if (!handler.getSupportedCodecs().includes(config.targetVideoCodec)) {
      throw new UnsupportedMediaTypeException(
        `${config.accel.toUpperCase()} acceleration does not support codec '${config.targetVideoCodec.toUpperCase()}'. Supported codecs: ${handler.getSupportedCodecs()}`,
      );
    }

    return handler;
  }

  isSRGB(asset: AssetEntity): boolean {
    const { colorspace, profileDescription, bitsPerSample } = asset.exifInfo ?? {};
    if (colorspace || profileDescription) {
      return [colorspace, profileDescription].some((s) => s?.toLowerCase().includes('srgb'));
    } else if (bitsPerSample) {
      // assume sRGB for 8-bit images with no color profile or colorspace metadata
      return bitsPerSample === 8;
    } else {
      // assume sRGB for images with no relevant metadata
      return true;
    }
  }

  private parseBitrateToBps(bitrateString: string) {
    const bitrateValue = Number.parseInt(bitrateString);

    if (Number.isNaN(bitrateValue)) {
      return 0;
    }

    if (bitrateString.toLowerCase().endsWith('k')) {
      return bitrateValue * 1000; // Kilobits per second to bits per second
    } else if (bitrateString.toLowerCase().endsWith('m')) {
      return bitrateValue * 1_000_000; // Megabits per second to bits per second
    } else {
      return bitrateValue;
    }
  }

  private async shouldUseExtractedImage(extractedPath: string, targetSize: number) {
    const { width, height } = await this.mediaRepository.getImageDimensions(extractedPath);
    const extractedSize = Math.min(width, height);

    return extractedSize >= targetSize;
  }

  private async getDevices() {
    if (!this.devices) {
      this.devices = await this.storageRepository.readdir('/dev/dri');
    }

    return this.devices;
  }

  private async hasOpenCL() {
    if (this.openCL === null) {
      try {
        const maliIcdStat = await this.storageRepository.stat('/etc/OpenCL/vendors/mali.icd');
        const maliDeviceStat = await this.storageRepository.stat('/dev/mali0');
        this.openCL = maliIcdStat.isFile() && maliDeviceStat.isCharacterDevice();
      } catch {
        this.logger.warn('OpenCL not available for transcoding, using CPU instead.');
        this.openCL = false;
      }
    }

    return this.openCL;
  }
}

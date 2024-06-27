import 'package:immich_mobile/entities/exif_info.entity.dart';
import 'package:intl/intl.dart';

String getAltText(ExifInfo? exifInfo, DateTime? fileCreatedAt) {
  if (exifInfo?.description != null && exifInfo!.description!.isNotEmpty) {
    return exifInfo!.description!;
  }

  String altText = 'Image taken';

  if (exifInfo?.city != null && exifInfo?.country != null) {
    altText += ' in ${exifInfo!.city}, ${exifInfo.country}';
  }

  if (fileCreatedAt != null) {
    String date = DateFormat.yMMMMd().format(fileCreatedAt);
    altText += ' on $date';
  }

  return altText;
}

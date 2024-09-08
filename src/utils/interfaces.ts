export interface NFTConfig {
    uploadPath: string;
    imgFileName: string;
    imgType: string;
    imgName: string;
    description: string;
    attributes: Array<{
      trait_type: string;
      value: string;
    }>;
}
  
export interface UriConfig extends NFTConfig {
    imageURI: string;
}

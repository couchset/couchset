export interface PaginationArgs {
    bucketName: string;
    select?: any[] | string;
    where: any;
    page?: number;
    limit?: number;
    offset?: number;
    orderBy?: any;
}
